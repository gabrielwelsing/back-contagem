const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    /\.railway\.app$/
];
app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        const isAllowed = allowedOrigins.some(o => o instanceof RegExp ? o.test(origin) : o === origin);
        if (isAllowed) callback(null, true);
        else callback(new Error('Bloqueado pela política de CORS'));
    },
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const hubPool = new Pool({
    connectionString: process.env.HUB_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- CRIAÇÃO E MIGRAÇÃO AUTOMÁTICA ---
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS projetos (
                id SERIAL PRIMARY KEY,
                ns VARCHAR(10) NOT NULL,
                data_registro VARCHAR(20) NOT NULL,
                postes JSONB NOT NULL DEFAULT '[]',
                total NUMERIC(10,2) NOT NULL DEFAULT 0,
                categorias_globais JSONB NOT NULL DEFAULT '[]',
                topografo VARCHAR(50) DEFAULT '',
                ambiental VARCHAR(10) DEFAULT 'NÃO',
                servidao VARCHAR(10) DEFAULT '',
                km_valor NUMERIC(10,2) DEFAULT 0,
                criado_em TIMESTAMP DEFAULT NOW()
            );
        `);
        const cols = ['topografo VARCHAR(50) DEFAULT \'\'', 'ambiental VARCHAR(10) DEFAULT \'NÃO\'', 'servidao VARCHAR(10) DEFAULT \'\'', 'km_valor NUMERIC(10,2) DEFAULT 0'];
        const names = ['topografo', 'ambiental', 'servidao', 'km_valor'];
        for (let i = 0; i < names.length; i++) {
            await pool.query(`ALTER TABLE projetos ADD COLUMN IF NOT EXISTS ${names[i]} ${cols[i].split(' ').slice(1).join(' ')}`).catch(() => {});
        }
        await pool.query(`ALTER TABLE projetos ADD COLUMN IF NOT EXISTS user_id BIGINT`).catch(() => {});
        await pool.query(`ALTER TABLE projetos ADD COLUMN IF NOT EXISTS empresa VARCHAR(255)`).catch(() => {});
        await pool.query(`
            CREATE TABLE IF NOT EXISTS empresa_configs (
                id SERIAL PRIMARY KEY,
                empresa VARCHAR(255) NOT NULL,
                tipo VARCHAR(50) NOT NULL,
                valores JSONB NOT NULL DEFAULT '[]',
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(empresa, tipo)
            );
        `);
        console.log('✅ Tabela "projetos" verificada/migrada.');
        console.log('✅ Tabela "empresa_configs" verificada/criada.');
    } catch (err) {
        console.error('❌ Erro ao criar tabela:', err.message);
    }
}
initDB();

// --- HEALTH ---
app.get('/', (req, res) => {
    res.json({ success: true, message: 'API Contagem Croqui rodando!' });
});

// --- VALIDAÇÃO DE TOKEN DO HUB ---
app.get('/api/auth/validate', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Token ausente' });

    const token = auth.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await hubPool.query(`SELECT token_version FROM users WHERE id = $1`, [decoded.user_id]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
        if (user.token_version !== decoded.token_version) return res.status(401).json({ error: 'Sessão encerrada' });
        res.json({ ok: true, user: decoded });
    } catch (err) {
        res.status(401).json({ error: 'Token inválido ou expirado' });
    }
});

// --- MIDDLEWARE: bloqueia sem token válido ---
async function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Token ausente' });

    const token = auth.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await hubPool.query(`SELECT token_version FROM users WHERE id = $1`, [decoded.user_id]);
        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });
        if (user.token_version !== decoded.token_version) return res.status(401).json({ error: 'Sessão encerrada' });
        req.userDecoded = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token inválido ou expirado' });
    }
}

// --- ROTAS ---

app.get('/api/projetos', requireAuth, async (req, res) => {
    try {
        const { de, ate } = req.query;
        const user = req.userDecoded;
        const params = [];
        const conditions = [];

        if (user && user.role === 'user') {
            params.push(user.user_id);
            conditions.push(`user_id = $${params.length}`);
        }

        if (de) {
            params.push(de);
            conditions.push(`criado_em >= TO_TIMESTAMP($${params.length}, 'DD/MM/YYYY')`);
        }
        if (ate) {
            params.push(ate);
            conditions.push(`criado_em < TO_TIMESTAMP($${params.length}, 'DD/MM/YYYY') + INTERVAL '1 day'`);
        }

        let query = 'SELECT * FROM projetos';
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY criado_em DESC';

        const result = await pool.query(query, params);
        res.json({ success: true, projetos: result.rows });
    } catch (error) {
        console.error('Erro GET /api/projetos:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao buscar projetos.' });
    }
});

app.post('/api/projetos', requireAuth, async (req, res) => {
    try {
        const { ns, data_registro, postes, total, categorias_globais, topografo, ambiental, servidao, km_valor } = req.body;
        const user = req.userDecoded;

        const errors = [];

        if (!ns || !/^\d{10}$/.test(ns)) {
            errors.push('NS deve ter exatamente 10 dígitos numéricos.');
        }

        const topografoStr = (topografo || '').toString().trim();
        if (!topografoStr || topografoStr.length > 50) {
            errors.push('Topógrafo é obrigatório e deve ter no máximo 50 caracteres.');
        }

        if (!Array.isArray(categorias_globais)) {
            errors.push('Categorias deve ser um array.');
        }

        if (!Array.isArray(postes)) {
            errors.push('Postes deve ser um array.');
        } else if (postes.length > 500) {
            errors.push('Máximo de 500 postes permitidos por projeto.');
        } else {
            const tiposPosteValidos = ['projetado', 'existente', 'rural'];
            for (let i = 0; i < postes.length; i++) {
                const p = postes[i];
                if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || isNaN(p.x) || isNaN(p.y)) {
                    errors.push(`Poste na posição ${i} possui coordenadas (x, y) inválidas.`);
                    break;
                }
                if (!tiposPosteValidos.includes(p.tipo)) {
                    errors.push(`Poste na posição ${i} possui tipo inválido. Permitidos: projetado, existente, rural.`);
                    break;
                }
            }
        }

        if (ambiental !== 'SIM' && ambiental !== 'NÃO') {
            errors.push('Ambiental deve ser SIM ou NÃO.');
        }

        if (servidao && !['SST', 'SSC', 'SSTC'].includes(servidao)) {
            errors.push('Servidão deve ser SST, SSC, SSTC ou vazio.');
        }

        const kmParsed = parseFloat(km_valor) || 0;
        if (kmParsed < 0) errors.push('KM valor não pode ser negativo.');

        const totalParsed = parseFloat(total) || 0;
        if (totalParsed < 0) errors.push('Total não pode ser negativo.');

        if (errors.length > 0) {
            return res.status(400).json({ success: false, errors });
        }

        const userId = user ? user.user_id : null;
        const empresa = user ? (user.empresa || null) : null;

        const result = await pool.query(
            `INSERT INTO projetos (ns, data_registro, postes, total, categorias_globais, topografo, ambiental, servidao, km_valor, user_id, empresa)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
            [ns, data_registro, JSON.stringify(postes), totalParsed, JSON.stringify(categorias_globais),
             topografoStr, ambiental, servidao || '', kmParsed, userId, empresa]
        );

        res.status(201).json({ success: true, projeto: result.rows[0] });
    } catch (error) {
        console.error('Erro POST /api/projetos:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao salvar projeto.' });
    }
});

app.delete('/api/projetos/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM projetos WHERE id = $1', [id]);
        res.json({ success: true, message: 'Projeto removido.' });
    } catch (error) {
        console.error('Erro DELETE /api/projetos:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao apagar projeto.' });
    }
});

// --- CONFIGS POR EMPRESA ---

app.get('/api/configs/:empresa/:tipo', requireAuth, async (req, res) => {
    try {
        const { empresa, tipo } = req.params;
        const tiposValidos = ['categorias', 'topografos'];
        if (!tiposValidos.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });

        const result = await pool.query(
            `SELECT valores FROM empresa_configs WHERE empresa = $1 AND tipo = $2`,
            [empresa, tipo]
        );
        res.json({ success: true, valores: result.rows[0]?.valores || null });
    } catch (err) {
        console.error('Erro GET /api/configs:', err.message);
        res.status(500).json({ error: 'Erro ao buscar configs.' });
    }
});

app.put('/api/configs/:empresa/:tipo', requireAuth, async (req, res) => {
    try {
        const user = req.userDecoded;
        if (!user || user.role !== 'admin_empresa') {
            return res.status(403).json({ error: 'Apenas admin_empresa pode alterar configurações.' });
        }

        if (user.empresa !== req.params.empresa) {
            return res.status(403).json({ error: 'Sem permissão para esta empresa.' });
        }

        const { empresa, tipo } = req.params;
        const tiposValidos = ['categorias', 'topografos'];
        if (!tiposValidos.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido.' });

        const { valores } = req.body;
        if (!Array.isArray(valores)) return res.status(400).json({ error: 'valores deve ser um array.' });

        const sanitized = valores
            .map(v => String(v).trim().toUpperCase())
            .filter(v => v.length > 0 && v.length <= 50);

        if (sanitized.length === 0) return res.status(400).json({ error: 'Lista não pode ficar vazia.' });

        await pool.query(`
            INSERT INTO empresa_configs (empresa, tipo, valores, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (empresa, tipo) DO UPDATE SET valores = $3, updated_at = NOW()
        `, [empresa, tipo, JSON.stringify(sanitized)]);

        res.json({ success: true, valores: sanitized });
    } catch (err) {
        console.error('Erro PUT /api/configs:', err.message);
        res.status(500).json({ error: 'Erro ao salvar configs.' });
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor Contagem Croqui na porta ${port}`);
});

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

// Pool do banco PRÓPRIO do app — projetos/postes
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Pool do banco do HUB — usado APENAS para validar token_version
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
        console.log('✅ Tabela "projetos" verificada/migrada.');
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
// Checa assinatura JWT + token_version no banco do hub
// Se o usuário deslogou do hub, token_version foi incrementado
// e esse endpoint rejeita na hora — acesso bloqueado instantaneamente
app.get('/api/auth/validate', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Token ausente' });

    const token = auth.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const result = await hubPool.query(
            `SELECT token_version FROM users WHERE id = $1`,
            [decoded.user_id]
        );

        const user = result.rows[0];
        if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

        if (user.token_version !== decoded.token_version) {
            return res.status(401).json({ error: 'Sessão encerrada' });
        }

        res.json({ ok: true, user: decoded });
    } catch (err) {
        res.status(401).json({ error: 'Token inválido ou expirado' });
    }
});

// --- ROTAS ---

// Listar projetos (com filtro de data opcional)
app.get('/api/projetos', async (req, res) => {
    try {
        const { de, ate } = req.query;
        let query = 'SELECT * FROM projetos';
        const params = [];
        const conditions = [];

        if (de) {
            params.push(de);
            conditions.push(`criado_em >= TO_TIMESTAMP($${params.length}, 'DD/MM/YYYY')`);
        }
        if (ate) {
            params.push(ate);
            conditions.push(`criado_em < TO_TIMESTAMP($${params.length}, 'DD/MM/YYYY') + INTERVAL '1 day'`);
        }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY criado_em DESC';

        const result = await pool.query(query, params);
        res.json({ success: true, projetos: result.rows });
    } catch (error) {
        console.error('Erro GET /api/projetos:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao buscar projetos.' });
    }
});

// Criar novo projeto
app.post('/api/projetos', async (req, res) => {
    try {
        const { ns, data_registro, postes, total, categorias_globais, topografo, ambiental, servidao, km_valor } = req.body;

        const errors = [];

        if (!ns || !/^\d{10}$/.test(ns)) {
            errors.push('NS deve ter exatamente 10 dígitos numéricos.');
        }

        const topografoStr = (topografo || '').toString().trim();
        if (!topografoStr || topografoStr.length > 50) {
            errors.push('Topógrafo é obrigatório e deve ter no máximo 50 caracteres.');
        }

        const categoriasValidas = ['AC', 'EXT.RURAL', 'EXT.URB', 'MOD.URB', 'AFAST/REM', 'RL/BRT', 'PASTO', 'ESTRADA'];
        if (!Array.isArray(categorias_globais)) {
            errors.push('Categorias deve ser um array.');
        } else {
            const categoriasInvalidas = categorias_globais.filter(c => !categoriasValidas.includes(c));
            if (categoriasInvalidas.length > 0) {
                errors.push('Categorias inválidas encontradas: ' + categoriasInvalidas.join(', ') + '. Permitidos: ' + categoriasValidas.join(', '));
            }
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
        if (kmParsed < 0) {
            errors.push('KM valor não pode ser negativo.');
        }

        const totalParsed = parseFloat(total) || 0;
        if (totalParsed < 0) {
            errors.push('Total não pode ser negativo.');
        }

        if (errors.length > 0) {
            return res.status(400).json({ success: false, errors });
        }

        const result = await pool.query(
            `INSERT INTO projetos (ns, data_registro, postes, total, categorias_globais, topografo, ambiental, servidao, km_valor)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [ns, data_registro, JSON.stringify(postes), totalParsed, JSON.stringify(categorias_globais),
             topografoStr, ambiental, servidao || '', kmParsed]
        );

        res.status(201).json({ success: true, projeto: result.rows[0] });
    } catch (error) {
        console.error('Erro POST /api/projetos:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao salvar projeto.' });
    }
});

// Apagar projeto
app.delete('/api/projetos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM projetos WHERE id = $1', [id]);
        res.json({ success: true, message: 'Projeto removido.' });
    } catch (error) {
        console.error('Erro DELETE /api/projetos:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao apagar projeto.' });
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor Contagem Croqui na porta ${port}`);
});

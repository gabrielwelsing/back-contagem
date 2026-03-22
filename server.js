const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
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
        // Migração: adicionar colunas se não existirem (para bancos já criados)
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

// --- ROTAS ---

app.get('/', (req, res) => {
    res.json({ success: true, message: 'API Contagem Croqui rodando!' });
});

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

        if (!ns || ns.length !== 10) {
            return res.status(400).json({ success: false, error: 'NS deve ter exatamente 10 caracteres.' });
        }

        const result = await pool.query(
            `INSERT INTO projetos (ns, data_registro, postes, total, categorias_globais, topografo, ambiental, servidao, km_valor)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [ns, data_registro, JSON.stringify(postes), total, JSON.stringify(categorias_globais),
             topografo || '', ambiental || 'NÃO', servidao || '', km_valor || 0]
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

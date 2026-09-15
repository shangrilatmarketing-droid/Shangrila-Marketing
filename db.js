'use strict';
const {Pool} = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {blankBudget} = require('./domain');
const LOCK = 73400521;
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const revision = plans => '"' + createHash('sha256').update(JSON.stringify(canonical(plans))).digest('hex') + '"';

async function createPostgresStore(options = {}) {
    if (!options.pool && !options.connectionString && !process.env.DATABASE_URL && !process.env.PGHOST) {
        throw new Error('PostgreSQL is required. Start the Docker Compose stack or configure PGHOST / DATABASE_URL.');
    }
    const pool = options.pool || new Pool({
        ...(options.connectionString || process.env.DATABASE_URL ? {connectionString:options.connectionString || process.env.DATABASE_URL} : {}),
        max:10, connectionTimeoutMillis:5000, idleTimeoutMillis:30000,
        application_name:'plan-reminder'
    });
    pool.on('error', error => console.error('PostgreSQL connection error:', error.code || 'connection unavailable'));
    function repository(client) {
        return {
            async read(name) {
                if (name === 'users') return (await client.query('SELECT document FROM users ORDER BY email')).rows.map(r => r.document);
                if (name === 'database') return (await client.query('SELECT document FROM plans ORDER BY sort_order, id')).rows.map(r => r.document);
                if (name === 'budget') return {...blankBudget(), ...Object.fromEntries((await client.query('SELECT company, annual_budget FROM company_budgets ORDER BY company')).rows.map(r => [r.company, Number(r.annual_budget)]))};
                if (name === 'reminders') return Object.fromEntries((await client.query('SELECT email, max(delivery_date) AS date FROM email_digest_deliveries WHERE sent_at IS NOT NULL GROUP BY email')).rows.map(r => [r.email, r.date]));
                throw new Error('Unknown collection.');
            },
            async write(name, value) {
                if (name === 'users' || name === 'database') {
                    const users = name === 'users';
                    const table = users ? 'users' : 'plans', key = users ? 'email' : 'id';
                    const ids = value.map(record => users ? record.email.toLowerCase() : String(record.id));
                    if (new Set(ids).size !== ids.length) throw new Error('Duplicate record IDs.');
                    // Only constant, allowlisted identifiers are interpolated. Values are parameters.
                    await client.query(`DELETE FROM ${table} WHERE NOT (${key} = ANY($1::text[]))`, [ids]);
                    if (value.length) {
                        const records = value.map((document, sort_order) => ({key:ids[sort_order], document, sort_order}));
                        await client.query(users
                            ? `INSERT INTO users(email, document) SELECT key, document FROM jsonb_to_recordset($1::jsonb) AS r(key text, document jsonb, sort_order integer) ON CONFLICT(email) DO UPDATE SET document=EXCLUDED.document`
                            : `INSERT INTO plans(id, sort_order, document) SELECT key, sort_order, document FROM jsonb_to_recordset($1::jsonb) AS r(key text, document jsonb, sort_order integer) ON CONFLICT(id) DO UPDATE SET sort_order=EXCLUDED.sort_order, document=EXCLUDED.document`, [JSON.stringify(records)]);
                    }
                } else if (name === 'budget') {
                    for (const [company, amount] of Object.entries(value)) await client.query('INSERT INTO company_budgets(company, annual_budget) VALUES($1,$2) ON CONFLICT(company) DO UPDATE SET annual_budget=EXCLUDED.annual_budget', [company, amount]);
                } else if (name === 'reminders') {
                    for (const [email, date] of Object.entries(value)) await client.query('INSERT INTO email_digest_deliveries(email, delivery_date, sent_at) VALUES($1,$2,now()) ON CONFLICT(email,delivery_date) DO UPDATE SET sent_at=EXCLUDED.sent_at, claim_token=NULL, lease_until=NULL', [email,date]);
                } else throw new Error('Unknown collection.');
            },
            async putUpload(filename, contentType, bytes, creator = null) {
                await client.query('INSERT INTO plan_uploads(filename,content_type,file_data,created_by) VALUES($1,$2,$3,$4)', [filename,contentType,bytes,creator]);
            },
            async getUpload(filename) { return (await client.query('SELECT content_type, file_data FROM plan_uploads WHERE filename=$1', [filename])).rows[0]; },
            async hasUpload(filename) { return (await client.query('SELECT 1 FROM plan_uploads WHERE filename=$1', [filename])).rowCount > 0; },
            query: (sql, parameters) => client.query(sql, parameters),
            revision
        };
    }
    async function transaction(work) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // The app saves ordered collections. Serialize read/modify/write across
            // connections and app instances so ETag checks and first-admin creation are atomic.
            await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
            const result = await work(repository(client));
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally { client.release(); }
    }
    try {
        await transaction(async tx => {
            await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
            for (const name of fs.readdirSync(path.join(__dirname,'migrations')).filter(name => name.endsWith('.sql')).sort()) {
                if ((await tx.query('SELECT 1 FROM schema_migrations WHERE version=$1',[name])).rowCount) continue;
                await tx.query(fs.readFileSync(path.join(__dirname,'migrations',name),'utf8'));
                await tx.query('INSERT INTO schema_migrations(version) VALUES($1)',[name]);
            }
        });
    } catch (error) { if (!options.pool) await pool.end(); throw error; }
    const store = repository(pool);
    store.write = (name, value) => transaction(tx => tx.write(name, value));
    store.putUpload = (...args) => transaction(tx => tx.putUpload(...args));
    store.transaction = transaction;
    store.health = async () => { await pool.query('SELECT 1 FROM users LIMIT 1'); };
    store.close = () => options.pool ? Promise.resolve() : pool.end();
    store.claimDigest = async (email, date) => {
        const token = randomUUID();
        const result = await pool.query(`INSERT INTO email_digest_deliveries(email,delivery_date,lease_until,claim_token) VALUES($1,$2,now()+interval '5 minutes',$3)
          ON CONFLICT(email,delivery_date) DO UPDATE SET lease_until=EXCLUDED.lease_until, claim_token=EXCLUDED.claim_token
          WHERE email_digest_deliveries.sent_at IS NULL AND email_digest_deliveries.lease_until < now() RETURNING claim_token`, [email,date,token]);
        return result.rowCount ? token : null;
    };
    store.finishDigest = async (email,date,token,success) => {
        if (success) await pool.query('UPDATE email_digest_deliveries SET sent_at=now(),lease_until=NULL,claim_token=NULL WHERE email=$1 AND delivery_date=$2 AND claim_token=$3',[email,date,token]);
        else await pool.query('DELETE FROM email_digest_deliveries WHERE email=$1 AND delivery_date=$2 AND claim_token=$3 AND sent_at IS NULL',[email,date,token]);
    };
    return store;
}
module.exports = {createPostgresStore, revision};

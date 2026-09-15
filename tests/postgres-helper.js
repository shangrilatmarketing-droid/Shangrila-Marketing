'use strict';
const {Pool}=require('pg');
const {randomUUID}=require('node:crypto');
async function testDatabase() {
    if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL test database.');
    const schema='planner_test_'+randomUUID().replaceAll('-','');
    const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    await admin.query('CREATE SCHEMA '+schema);
    const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path='+schema});
    return {database:{pool},async close() {
        await pool.end();
        if (!/^planner_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected test schema.');
        await admin.query('DROP SCHEMA '+schema+' CASCADE');
        await admin.end();
    }};
}
module.exports={testDatabase};

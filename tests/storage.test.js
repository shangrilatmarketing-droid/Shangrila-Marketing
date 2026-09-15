'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createStore} = require('../store');
const {createApplication} = require('../server');
const {testDatabase}=require('./postgres-helper');
function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'plan-reminder-storage-'));
    t.after(() => {
        const resolved = fs.realpathSync(directory);
        assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());
        assert.ok(path.basename(resolved).startsWith('plan-reminder-storage-'));
        fs.rmSync(resolved,{recursive:true,force:true});
    });
    return directory;
}
test('legacy object databases migrate with a backup and one shared admin budget',t => {
    const directory = temporary(t);
    fs.writeFileSync(path.join(directory,'users.json'),JSON.stringify([{email:'owner@example.test',isAdmin:true,annualBudget:{SOTC:1200}}]));
    fs.writeFileSync(path.join(directory,'database.json'),JSON.stringify({'owner@example.test':[{id:'old',title:'Existing plan'}]}));
    const store = createStore(directory);
    assert.equal(store.read('database')[0].createdBy,'owner@example.test');
    assert.equal(store.read('budget').SOTC,1200);
    assert.ok(fs.readdirSync(directory).some(f => f.includes('.pre-migration-')));
    assert.equal(fs.readdirSync(directory).some(f => f.endsWith('.tmp')),false);
});
test('Docker data import preserves source files and refuses a second import',t => {
    const directory = temporary(t);
    const source = path.join(directory,'source'), destination = path.join(directory,'data');
    fs.mkdirSync(path.join(source,'uploads'),{recursive:true});
    fs.writeFileSync(path.join(source,'users.json'),'[]');
    fs.writeFileSync(path.join(source,'database.json'),'[]');
    fs.writeFileSync(path.join(source,'budget.json'),'{}');
    fs.writeFileSync(path.join(source,'uploads','example.png'),'fixture');
    const script = path.join(__dirname,'../scripts/import-data.js');
    const options = {env:{...process.env,DATA_DIR:destination},encoding:'utf8'};
    const result = spawnSync(process.execPath,[script,source],options);
    assert.equal(result.status,0,result.stderr);
    assert.equal(fs.readFileSync(path.join(destination,'uploads','example.png'),'utf8'),'fixture');
    assert.equal(fs.readFileSync(path.join(source,'database.json'),'utf8'),'[]');
    const repeat = spawnSync(process.execPath,[script,source],options);
    assert.notEqual(repeat.status,0);
    assert.match(repeat.stderr,/Destination contains existing data/);
});
test('production refuses weak session secrets and unconfigured email fails clearly',async t => {
    const directory = temporary(t);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { await assert.rejects(createApplication({secret:'weak',transporter:null}),/JWT_SECRET/); }
    finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
    const fixture=await testDatabase(); t.after(() => fixture.close());
    const {app,store} = await createApplication({database:fixture.database,secret:'test-secret-at-least-thirty-two-characters',transporter:null});
    const jwt = require('jsonwebtoken');
    await store.write('users',[{email:'owner@example.test',isApproved:true}]);
    const token = jwt.sign({email:'owner@example.test'},'test-secret-at-least-thirty-two-characters');
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/test-email',{method:'POST',headers:{Authorization:'Bearer ' + token}});
        assert.equal(response.status,503);
        assert.match((await response.json()).error,/not configured/);
    } finally {await new Promise(resolve => server.close(resolve));}
});

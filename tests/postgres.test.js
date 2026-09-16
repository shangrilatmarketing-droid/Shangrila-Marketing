'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const bcrypt=require('bcryptjs');
const {createPostgresStore,revision}=require('../db');
const {createApplication}=require('../server');
const {readSnapshot,importSnapshot}=require('../scripts/import-json');
const {mergeSnapshot}=require('../scripts/merge-json');
const {testDatabase}=require('./postgres-helper');
const secret='postgres-integration-secret-at-least-32-characters';
const plan={id:'legacy-task',title:'Existing campaign',description:'Preserve this',date:'2027-12-20',time:'10:00',company:'SOTC',cost:1200,timeframe:'event',status:'completed',completedAt:123456789,createdBy:'owner@example.test',photoUrl:'/uploads/old.png',repetitionsLeft:0};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3e0AAAAASUVORK5CYII=','base64');
async function setup(t) {const fixture=await testDatabase();t.after(() => fixture.close());return {fixture,store:await createPostgresStore(fixture.database)};}
function sourceFiles(t) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'planner-pg-migrate-'));
    t.after(() => {
        const resolved=fs.realpathSync(directory);
        assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));
        assert.match(path.basename(resolved),/^planner-pg-migrate-/);
        fs.rmSync(resolved,{recursive:true,force:true});
    });
    fs.mkdirSync(path.join(directory,'uploads'));
    const users=[{email:'owner@example.test',password:bcrypt.hashSync('Existing-password-42',4),isAdmin:true,isApproved:true,tokenVersion:4,emailNotificationTime:'11:30'}];
    fs.writeFileSync(path.join(directory,'users.json'),JSON.stringify(users));
    fs.writeFileSync(path.join(directory,'database.json'),JSON.stringify({'owner@example.test':[plan,{...plan,id:'junk-task',status:'junk',deletedBy:'owner@example.test',deletedAt:555}]}));
    fs.writeFileSync(path.join(directory,'budget.json'),JSON.stringify({SOTC:50000}));
    fs.writeFileSync(path.join(directory,'reminders.json'),JSON.stringify({'owner@example.test':'2026-09-14'}));
    fs.writeFileSync(path.join(directory,'uploads/old.png'),png);
    return directory;
}
async function serve(t,service) {
    const server=service.app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    return 'http://127.0.0.1:'+server.address().port;
}
test('PostgreSQL import preserves password hashes, history, order, budgets, reminders, images and source files',async t=>{
    const {fixture,store}=await setup(t), directory=sourceFiles(t), snapshot=readSnapshot(directory);
    const before=fs.readFileSync(path.join(directory,'database.json'));
    assert.deepEqual(await importSnapshot(store,snapshot),{users:1,plans:2,uploads:1,budgets:5});
    const reopened=await createPostgresStore(fixture.database);
    assert.deepEqual(await reopened.read('users'),snapshot.users);
    assert.deepEqual(await reopened.read('database'),snapshot.plans);
    assert.equal((await reopened.read('budget')).SOTC,50000);
    assert.equal((await reopened.read('reminders'))['owner@example.test'],'2026-09-14');
    assert.deepEqual((await reopened.getUpload('old.png')).file_data,png);
    const columns=await reopened.query('SELECT title,cost,status,sort_order FROM plans ORDER BY sort_order');
    assert.equal(columns.rows[0].title,plan.title);assert.equal(Number(columns.rows[0].cost),1200);
    await assert.rejects(importSnapshot(reopened,snapshot),/not empty/);
    assert.deepEqual(fs.readFileSync(path.join(directory,'database.json')),before);
    const app=await createApplication({database:fixture.database,secret,transporter:null});
    const url=await serve(t,app);
    const login=await fetch(url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'Existing-password-42'})});
    assert.equal(login.status,200);
    const photo=await fetch(url+'/uploads/old.png',{headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()),png);
});
test('guarded merge restores legacy rows while retaining current collisions',async t=>{
    const {store}=await setup(t), snapshot=readSnapshot(sourceFiles(t));
    const currentUser={...snapshot.users[0],password:bcrypt.hashSync('Current-password-42',4)};
    const currentPlan={...snapshot.plans[0],title:'Current version'};
    await store.write('users',[currentUser,{...currentUser,email:'new@example.test'}]);
    await store.write('database',[currentPlan]);
    await store.write('budget',{SOTC:99999});
    const preview=await mergeSnapshot(store,snapshot);
    assert.deepEqual(preview.source,{users:1,plans:2,uploads:1});
    assert.deepEqual(preview.currentBefore,{users:2,plans:1,uploads:0});
    assert.deepEqual(preview.overlaps,{users:1,plans:1,uploads:0});
    assert.equal((await store.read('database')).length,1);
    const applied=await mergeSnapshot(store,snapshot,{apply:true});
    assert.deepEqual(applied.final,{users:2,plans:2,uploads:1});
    assert.equal((await store.read('users')).find(user=>user.email===currentUser.email).password,currentUser.password);
    assert.equal((await store.read('database')).find(plan=>plan.id===currentPlan.id).title,'Current version');
    assert.equal((await store.read('budget')).SOTC,99999);
    assert.ok(await store.getUpload('old.png'));
    await assert.rejects(mergeSnapshot(store,snapshot,{apply:true}),/already recorded/);
});
test('failed migration rolls back every collection, and concurrent imports cannot both succeed',async t=>{
    const {store}=await setup(t), snapshot=readSnapshot(sourceFiles(t));
    const malformed={...snapshot,uploads:[...snapshot.uploads,...snapshot.uploads]};
    await assert.rejects(importSnapshot(store,malformed),/duplicate key/);
    assert.deepEqual(await store.read('users'),[]);assert.deepEqual(await store.read('database'),[]);
    assert.equal((await store.query('SELECT count(*) AS n FROM company_budgets')).rows[0].n,'0');
    const attempts=await Promise.allSettled([importSnapshot(store,snapshot),importSnapshot(store,snapshot)]);
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
});
test('migration refuses missing images and malformed legacy groups instead of dropping data',t=>{
    const directory=sourceFiles(t);
    fs.renameSync(path.join(directory,'uploads/old.png'),path.join(directory,'uploads/other.png'));
    assert.throws(()=>readSnapshot(directory),/Missing uploaded image/);
    fs.writeFileSync(path.join(directory,'database.json'),JSON.stringify({'owner@example.test':{bad:true}}));
    assert.throws(()=>readSnapshot(directory),/must be arrays/);
});
test('legacy repetition strings are normalized so zero does not create another occurrence',t=>{
    const directory=sourceFiles(t);
    fs.writeFileSync(path.join(directory,'database.json'),JSON.stringify([{...plan,repetitionsLeft:'0',cost:'1200.50'}]));
    const snapshot=readSnapshot(directory);
    assert.equal(snapshot.plans[0].repetitionsLeft,0);
    assert.equal(snapshot.plans[0].cost,1200.5);
    assert.equal(snapshot.plans[0].completedAt,plan.completedAt);
});
test('two app instances create exactly one first administrator and reject concurrent stale saves',async t=>{
    const {fixture,store}=await setup(t);
    const apps=await Promise.all([1,2].map(()=>createApplication({database:fixture.database,secret,transporter:null})));
    const urls=await Promise.all(apps.map(app=>serve(t,app)));
    const request=(base,route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    const accounts=['first@example.test','second@example.test'];
    const registrations=await Promise.all(urls.map((url,i)=>request(url,'/api/register',{email:accounts[i],password:'Concurrency-password-42'})));
    assert.deepEqual(registrations.map(r=>r.status),[201,201]);
    const owners=(await store.read('users')).filter(u=>u.isAdmin);
    assert.equal(owners.length,1);
    const login=await request(urls[0],'/api/login',{email:owners[0].email,password:'Concurrency-password-42'});
    const Cookie=login.headers.get('set-cookie').split(';')[0];
    const before=await fetch(urls[0]+'/api/plans',{headers:{Cookie}});
    const headers={Cookie,'If-Match':before.headers.get('etag')};
    const pending={...plan,status:'pending',photoUrl:null};
    const writes=await Promise.all(urls.map((url,i)=>request(url,'/api/plans',[{...pending,title:'Writer '+i}],headers)));
    assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);
    const winning=(await store.read('database'))[0];
    assert.match(winning.title,/Writer [01]/);
});
test('digest leases coordinate workers and allow retry only after a failed send',async t=>{
    const {fixture,store}=await setup(t), other=await createPostgresStore(fixture.database);
    const tokens=await Promise.all([store.claimDigest('a@example.test','2026-09-15'),other.claimDigest('a@example.test','2026-09-15')]);
    assert.equal(tokens.filter(Boolean).length,1);
    await store.finishDigest('a@example.test','2026-09-15',tokens.find(Boolean),false);
    const retry=await other.claimDigest('a@example.test','2026-09-15');assert.ok(retry);
    await other.finishDigest('a@example.test','2026-09-15',retry,true);
    assert.equal(await store.claimDigest('a@example.test','2026-09-15'),null);
});
test('ETags remain stable after PostgreSQL JSONB key ordering changes',()=>{
    assert.equal(revision([{id:'a',title:'x',nested:{a:1,b:2}}]),revision([{nested:{b:2,a:1},title:'x',id:'a'}]));
    assert.notEqual(revision([{id:'a'},{id:'b'}]),revision([{id:'b'},{id:'a'}]));
});

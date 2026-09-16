'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ExcelJS = require('exceljs');
const {createApplication} = require('../server');
const {testDatabase}=require('./postgres-helper');
let fixture;
let service, server, base, directory, adminCookie, memberCookie, revision;
const mail = [];
const password = 'Test-only-password-42';
const adminEmail = 'admin@example.test', memberEmail = 'member@example.test';
const basePlan = {id:'plan-one',title:'Team launch',description:'Marketing brief',date:'2026-12-20',time:'12:00',company:'SOTC',timeframe:'event',cost:1250.5,status:'pending',repetitionsLeft:0};
async function request(url, {method='GET',body,cookie=adminCookie,headers={}} = {}) {
    const res = await fetch(base + url, {method, headers:{...(cookie ? {Cookie:cookie} : {}), ...(body && !(body instanceof FormData) ? {'Content-Type':'application/json'} : {}),...headers}, body:body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)});
    return res;
}
async function login(email) {
    const response = await request('/api/login',{method:'POST',body:{email,password},cookie:null});
    assert.equal(response.status,200);
    assert.match(response.headers.get('set-cookie'),/HttpOnly/);
    return response.headers.get('set-cookie').split(';')[0];
}
async function readPlans() {
    const response = await request('/api/plans'); assert.equal(response.status,200);
    revision = response.headers.get('etag'); return response.json();
}
async function save(plans, expected=200, etag=revision) {
    const response = await request('/api/plans',{method:'POST',body:plans,headers:{'If-Match':etag}});
    assert.equal(response.status,expected,await response.clone().text());
    if (response.ok) revision = response.headers.get('etag');
    return response.json();
}
before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(),'plan-reminder-test-'));
    fixture=await testDatabase();
    service = await createApplication({database:fixture.database, secret:'test-secret-with-more-than-thirty-two-characters',transporter:{sendMail:async value => mail.push(value)}});
    server = service.app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
    base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fixture.close();
    const resolved = fs.realpathSync(directory);
    if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith('plan-reminder-test-')) throw new Error('Unexpected test cleanup path.');
    fs.rmSync(resolved,{recursive:true,force:true});
});
test('health and public assets work, private files and source code are inaccessible',async () => {
    assert.equal((await request('/health',{cookie:null})).status,200);
    for (const url of ['/','/login.html','/ui.js','/vendor/lucide.js']) assert.equal((await request(url,{cookie:null})).status,200,url);
    for (const url of ['/','/app.js','/styles.css']) assert.equal((await request(url,{cookie:null})).headers.get('cache-control'),'no-cache',url);
    for (const url of ['/users.json','/database.json','/budget.json','/.env','/server.js','/store.js','/package.json','/node_modules/bcryptjs/package.json']) assert.equal((await request(url,{cookie:null})).status,404,url);
    assert.equal((await request('/api/plans',{cookie:null})).status,401);
});
test('registration validates input and makes only the first account an approved administrator', async () => {
    assert.equal((await request('/api/register',{method:'POST',cookie:null,body:{email:'bad',password:'123'}})).status,400);
    const first = await request('/api/register',{method:'POST',cookie:null,body:{email:adminEmail,password}});
    assert.equal(first.status,201); assert.equal((await first.json()).isApproved,true);
    const responses = await Promise.all([memberEmail,'second@example.test'].map(email => request('/api/register',{method:'POST',cookie:null,body:{email,password}})));
    for (const response of responses) assert.equal(response.status,201);
    assert.equal((await service.store.read('users')).length,3);
    assert.equal((await service.store.read('users')).filter(u => u.isAdmin).length,1);
    assert.equal((await request('/api/login',{method:'POST',cookie:null,body:{email:memberEmail,password}})).status,403);
    assert.equal((await request('/api/register',{method:'POST',cookie:null,body:{email:adminEmail.toUpperCase(),password}})).status,409);
    adminCookie = await login(adminEmail.toUpperCase());
});
test('approval and role changes take effect immediately for existing sessions', async () => {
    await request('/api/admin/toggle-approval',{method:'POST',body:{targetEmail:memberEmail}});
    memberCookie = await login(memberEmail);
    assert.equal((await request('/api/admin/users',{cookie:memberCookie})).status,403);
    await request('/api/admin/toggle-role',{method:'POST',body:{targetEmail:memberEmail}});
    assert.equal((await request('/api/admin/users',{cookie:memberCookie})).status,200);
    await request('/api/admin/toggle-role',{method:'POST',body:{targetEmail:memberEmail}});
    assert.equal((await request('/api/admin/users',{cookie:memberCookie})).status,403);
    assert.equal((await request('/api/admin/toggle-role',{method:'POST',body:{targetEmail:adminEmail}})).status,400);
    const users = await (await request('/api/admin/users')).json();
    assert.equal(users.some(u => u.password),false);
});
test('plan saves use optimistic concurrency and cannot silently remove active plans', async () => {
    await readPlans(); const original = revision;
    const saved = await save([{...basePlan,createdBy:'forged@example.test'}]);
    assert.equal(saved.plans[0].createdBy,adminEmail);
    await save([{...basePlan,title:'Stale tab'}],409,original);
    await save([],400);
    const current = await readPlans(); assert.equal(current[0].title,'Team launch');
    assert.equal((await request('/api/plans',{method:'POST',body:current})).status,428);
    await save([{...basePlan,cost:-1}],400);
});
test('complete, archive, restore, Junk and permanent deletion preserve expected history', async () => {
    let current = await readPlans(); current[0].status = 'completed';
    let result = await save(current); assert.ok(result.plans[0].completedAt);
    const completedAt = result.plans[0].completedAt;
    current = result.plans; current[0].status = 'archived';
    result = await save(current); assert.equal(result.plans[0].completedAt,completedAt);
    current = result.plans; current[0].status = 'completed'; await save(current);
    current[0].status = 'pending'; result = await save(current); assert.equal(result.plans[0].completedAt,null);
    current = result.plans; current[0].status = 'junk'; result = await save(current); assert.equal(result.plans[0].deletedBy,adminEmail);
    current = result.plans; current[0].status = 'pending'; await save(current);
    current[0].status = 'junk'; await save(current); await save([]);
    assert.equal((await readPlans()).length,0);
});
test('image uploads reject active content and oversize data; allowed images require authentication', async () => {
    const invalid = new FormData(); invalid.append('photo',new Blob(['<svg onload="alert(1)"></svg>'],{type:'image/svg+xml'}),'bad.svg');
    assert.equal((await request('/api/upload',{method:'POST',body:invalid})).status,400);
    const tooBig = new FormData(); tooBig.append('photo',new Blob([new Uint8Array(5*1024*1024+1)]),'large.png');
    assert.equal((await request('/api/upload',{method:'POST',body:tooBig})).status,400);
    const data = new FormData(); data.append('photo',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3e0AAAAASUVORK5CYII=','base64')],{type:'image/png'}),'pixel.png');
    const response = await request('/api/upload',{method:'POST',body:data});
    assert.equal(response.status,201,await response.clone().text());
    const {photoUrl} = await response.json();
    assert.equal((await request(photoUrl,{cookie:null})).status,401);
    assert.equal((await request(photoUrl)).status,200);
});
test('settings validate money and time while members can save notification preferences', async () => {
    assert.equal((await request('/api/user/settings',{method:'POST',body:{annualBudget:{SOTC:-1}}})).status,400);
    assert.equal((await request('/api/user/settings',{method:'POST',body:{emailNotificationTime:'24:99'}})).status,400);
    assert.equal((await request('/api/user/settings',{method:'POST',cookie:memberCookie,body:{annualBudget:{SOTC:100}}})).status,403);
    const saved = await request('/api/user/settings',{method:'POST',cookie:memberCookie,body:{emailNotificationsEnabled:false,emailNotificationTime:'10:30'}});
    assert.equal(saved.status,200); assert.equal((await saved.json()).emailNotificationsEnabled,false);
    assert.equal((await request('/api/user/settings',{method:'POST',body:{annualBudget:{SOTC:15000}}})).status,200);
});
test('Excel export includes completed and archived plans with NPR formatting and totals', async () => {
    await readPlans(); await save([{...basePlan,status:'completed'},{...basePlan,id:'archived',status:'archived',cost:250}]);
    const response = await request('/api/export-report'); assert.equal(response.status,200);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    const sheet = workbook.getWorksheet('Completed Tasks');
    assert.equal(sheet.getCell('D1').value,'Cost (NPR)');
    assert.equal(sheet.getCell('D2').numFmt,'"NPR "#,##0.00');
    assert.equal(sheet.getCell('D5').value,1500.5);
});
test('daily digests exclude completed plans and unapproved users, escape HTML, and avoid duplicate delivery', async () => {
    await service.store.write('database',[{...basePlan,date:'2026-09-14',title:'<img src=x onerror="bad()">'},{...basePlan,id:'done',date:'2026-09-14',status:'completed'}]);
    await service.runMaintenance(new Date('2026-09-14T04:15:00Z'));
    await service.runMaintenance(new Date('2026-09-14T04:15:20Z'));
    assert.equal(mail.length,1);
    assert.equal(mail[0].to,adminEmail);
    assert.match(mail[0].html,/&lt;img/);
    assert.doesNotMatch(mail[0].html,/<img/);
    assert.match(mail[0].subject,/1 plans/);
});
test('cross-origin writes are rejected and revocation survives subsequent reapproval', async () => {
    assert.equal((await request('/api/logout',{method:'POST',headers:{Origin:'https://unrelated.example'}})).status,403);
    await request('/api/admin/toggle-approval',{method:'POST',body:{targetEmail:memberEmail}});
    assert.equal((await request('/api/plans',{cookie:memberCookie})).status,401);
    await request('/api/admin/toggle-approval',{method:'POST',body:{targetEmail:memberEmail}});
    assert.equal((await request('/api/plans',{cookie:memberCookie})).status,401);
});
test('password resets invalidate old sessions and data survives app recreation', async () => {
    const freshCookie = await login(memberEmail);
    const reset = await request('/api/admin/reset-password',{method:'POST',body:{targetEmail:memberEmail,newPassword:'Replacement-password-42'}});
    assert.equal(reset.status,200);
    assert.equal((await request('/api/plans',{cookie:freshCookie})).status,401);
    const reopened = await createApplication({database:fixture.database,secret:'test-secret-with-more-than-thirty-two-characters',transporter:null});
    assert.equal((await reopened.store.read('users')).length,3);
    assert.equal((await reopened.store.read('budget')).SOTC,15000);
    assert.equal((await reopened.store.read('database')).length,2);
});
test('custom order persists across reloads and application recreation without changing dates', async () => {
    const existing = await readPlans();
    const data = await save([...existing,{...basePlan,id:'last-created',date:'2027-01-15'}]);
    const stale = revision;
    const dates = Object.fromEntries(data.plans.map(p=>[p.id,p.date]));
    const reordered = [...data.plans].reverse();
    await save(reordered);
    const loaded = await readPlans();
    assert.deepEqual(loaded.map(p=>p.id),reordered.map(p=>p.id));
    assert.deepEqual(Object.fromEntries(loaded.map(p=>[p.id,p.date])),dates);
    await save(data.plans,409,stale);
    const recreated = await createApplication({database:fixture.database,secret:'test-secret-with-more-than-thirty-two-characters',transporter:null});
    assert.deepEqual((await recreated.store.read('database')).map(p=>p.id),reordered.map(p=>p.id));
});

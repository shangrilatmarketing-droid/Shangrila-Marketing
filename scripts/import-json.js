'use strict';
require('dotenv').config({quiet:true});
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createPostgresStore} = require('../db');
const {blankBudget, cleanEmail, money, validDate, validatePlans} = require('../domain');
function readSnapshot(directory) {
    const source=path.resolve(directory), fingerprint=createHash('sha256');
    function read(name, optional=false) {
        const file=path.join(source,name);
        if (optional && !fs.existsSync(file)) return null;
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Expected a regular source file: '+name);
        const bytes=fs.readFileSync(file); fingerprint.update(name).update(bytes);
        return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    }
    const users=read('users.json');
    if (!Array.isArray(users)) throw new Error('users.json must contain an array.');
    const emails=new Set();
    for (const user of users) {
        const email=cleanEmail(user.email);
        if (emails.has(email)) throw new Error('Duplicate user email in source.');
        emails.add(email);
        if (typeof user.password !== 'string' || !/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(user.password)) throw new Error('A user has an invalid password hash. Source was not changed.');
    }
    if (users.length && !users.some(u => u.isAdmin && u.isApproved !== false)) throw new Error('Source has no approved administrator. Correct account permissions before importing.');
    const legacy=read('database.json');
    let plans;
    if (Array.isArray(legacy)) plans=legacy;
    else if (legacy && typeof legacy==='object') plans=Object.entries(legacy).flatMap(([email,items]) => {
        if (!Array.isArray(items)) throw new Error('Legacy plan groups must be arrays.');
        return items.map(plan => ({...plan,createdBy:plan.createdBy || email}));
    });
    else throw new Error('database.json must be an array or email-keyed object.');
    plans=plans.map(p => ({...p,id:String(p.id || ''),cost:money(p.cost),
        repetitionsLeft:p.repetitionsLeft == null || p.repetitionsLeft === '' ? null : Number(p.repetitionsLeft)}));
    validatePlans(plans,plans,users[0]?.email || '');
    const budgetSource=read('budget.json',true);
    const fallback=users.find(u => u.isAdmin && u.annualBudget)?.annualBudget || {};
    const amounts=budgetSource && Object.keys(budgetSource).length ? budgetSource : fallback;
    if (!amounts || typeof amounts !== 'object' || Array.isArray(amounts)) throw new Error('Invalid budget.json.');
    const budget={...blankBudget(),...Object.fromEntries(Object.entries(amounts).map(([key,value]) => [key,money(value)]))};
    const reminders=read('reminders.json',true) || {};
    if (Array.isArray(reminders) || typeof reminders !== 'object') throw new Error('Invalid reminders.json.');
    for (const [email,date] of Object.entries(reminders)) {cleanEmail(email); if (!validDate(date)) throw new Error('Invalid previous digest date.');}
    const uploads=[], uploadDirectory=path.join(source,'uploads');
    if (fs.existsSync(uploadDirectory)) {
        if (fs.lstatSync(uploadDirectory).isSymbolicLink()) throw new Error('Upload directory must not be a symbolic link.');
        for (const name of fs.readdirSync(uploadDirectory).sort()) {
            const file=path.join(uploadDirectory,name), stat=fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || !/^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(name)) throw new Error('Unsupported upload entry: '+name);
            const bytes=fs.readFileSync(file);
            const type={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}[name.split('.').pop().toLowerCase()];
            fingerprint.update(name).update(bytes); uploads.push({name,type,bytes});
        }
    }
    const filenames=new Set(uploads.map(u => u.name));
    for (const plan of plans) if (plan.photoUrl && !filenames.has(path.basename(plan.photoUrl))) throw new Error('Missing uploaded image for plan '+plan.id+'. Copy uploads before importing.');
    return {users,plans,budget,reminders,uploads,id:fingerprint.digest('hex')};
}
async function importSnapshot(store,snapshot) {
    return store.transaction(async tx => {
        const occupied=await tx.query('SELECT (SELECT count(*) FROM users)+(SELECT count(*) FROM plans)+(SELECT count(*) FROM plan_uploads)+(SELECT count(*) FROM company_budgets)+(SELECT count(*) FROM email_digest_deliveries)+(SELECT count(*) FROM data_imports) AS total');
        if (Number(occupied.rows[0].total)!==0) throw new Error('Destination is not empty. Import only into a fresh PostgreSQL database; nothing was overwritten.');
        await tx.write('users',snapshot.users); await tx.write('database',snapshot.plans);
        await tx.write('budget',snapshot.budget); await tx.write('reminders',snapshot.reminders);
        for (const file of snapshot.uploads) await tx.putUpload(file.name,file.type,file.bytes);
        const summary={users:snapshot.users.length,plans:snapshot.plans.length,uploads:snapshot.uploads.length,budgets:Object.keys(snapshot.budget).length};
        await tx.query('INSERT INTO data_imports(id,summary) VALUES($1,$2::jsonb)',[snapshot.id,JSON.stringify(summary)]);
        return summary;
    });
}
if (require.main===module) {
    (async () => {
        const snapshot=readSnapshot(process.argv[2] || '/migration');
        if (process.argv.includes('--check')) {console.log(JSON.stringify({valid:true,users:snapshot.users.length,plans:snapshot.plans.length,uploads:snapshot.uploads.length}));return;}
        const store=await createPostgresStore();
        try {console.log('Imported into PostgreSQL:',JSON.stringify(await importSnapshot(store,snapshot)));}
        finally {await store.close();}
    })().catch(error => {console.error('Import failed:',error.message);process.exitCode=1;});
}
module.exports={readSnapshot,importSnapshot};

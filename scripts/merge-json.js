'use strict';
const {createHash}=require('node:crypto');
const {createPostgresStore}=require('../db');
const {readSnapshot}=require('./import-json');

function mergeCollections(snapshot,current,explicitBudgetCompanies) {
    const keyed=(legacyValues,currentValues,key) => {
        const result=new Map(legacyValues.map(value => [key(value),value]));
        // Current rows win on collisions so accounts or edits created after the
        // failed import are retained while missing legacy rows are restored.
        for (const value of currentValues) result.set(key(value),value);
        return [...result.values()];
    };
    const users=keyed(snapshot.users,current.users,user => user.email.toLowerCase());
    const plans=keyed(snapshot.plans,current.plans,plan => String(plan.id));
    const budget={...snapshot.budget};
    for (const company of explicitBudgetCompanies) budget[company]=current.budget[company];
    const reminders={...snapshot.reminders};
    for (const [email,date] of Object.entries(current.reminders)) {
        if (!reminders[email] || date>reminders[email]) reminders[email]=date;
    }
    return {users,plans,budget,reminders};
}

async function mergeSnapshot(store,snapshot,{apply=false}={}) {
    return store.transaction(async tx => {
        if ((await tx.query('SELECT count(*) AS n FROM data_imports')).rows[0].n!=='0') throw new Error('A legacy import is already recorded. Restore was not repeated.');
        const current={
            users:await tx.read('users'),plans:await tx.read('database'),
            budget:await tx.read('budget'),reminders:await tx.read('reminders')
        };
        const explicit=(await tx.query('SELECT company FROM company_budgets ORDER BY company')).rows.map(row => row.company);
        const merged=mergeCollections(snapshot,current,explicit);
        const currentUploads=(await tx.query('SELECT filename,file_data FROM plan_uploads ORDER BY filename')).rows;
        const byName=new Map(currentUploads.map(file => [file.filename,file.file_data]));
        let uploadOverlaps=0;
        for (const file of snapshot.uploads) {
            const existing=byName.get(file.name);
            if (!existing) continue;
            uploadOverlaps++;
            if (!Buffer.from(existing).equals(file.bytes)) throw new Error('An uploaded image has conflicting bytes: '+file.name+'. Nothing was changed.');
        }
        const currentUsers=new Set(current.users.map(user => user.email.toLowerCase()));
        const currentPlans=new Set(current.plans.map(plan => String(plan.id)));
        const summary={
            source:{users:snapshot.users.length,plans:snapshot.plans.length,uploads:snapshot.uploads.length},
            currentBefore:{users:current.users.length,plans:current.plans.length,uploads:currentUploads.length},
            overlaps:{users:snapshot.users.filter(user => currentUsers.has(user.email.toLowerCase())).length,
                plans:snapshot.plans.filter(plan => currentPlans.has(String(plan.id))).length,uploads:uploadOverlaps},
            final:{users:merged.users.length,plans:merged.plans.length,uploads:new Set([...byName.keys(),...snapshot.uploads.map(file => file.name)]).size}
        };
        if (!apply) return summary;
        await tx.write('users',merged.users);await tx.write('database',merged.plans);
        await tx.write('budget',merged.budget);await tx.write('reminders',merged.reminders);
        for (const file of snapshot.uploads) if (!byName.has(file.name)) await tx.putUpload(file.name,file.type,file.bytes);
        await tx.query('INSERT INTO data_imports(id,summary) VALUES($1,$2::jsonb)',[snapshot.id,JSON.stringify({...summary,mode:'guarded-merge'})]);
        return summary;
    });
}

if (require.main===module) {
    (async()=>{
        const snapshot=readSnapshot(process.argv[2]||'/migration');
        const store=await createPostgresStore();
        try {
            const apply=process.argv.includes('--apply');
            console.log((apply?'Merged legacy snapshot: ':'Merge preview: ')+JSON.stringify(await mergeSnapshot(store,snapshot,{apply})));
        } finally {await store.close();}
    })().catch(error=>{console.error('Merge failed:',error.message);process.exitCode=1;});
}
module.exports={mergeCollections,mergeSnapshot};

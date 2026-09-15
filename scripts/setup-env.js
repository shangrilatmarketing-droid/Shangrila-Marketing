'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const target=path.resolve(process.argv[2] || '.env.postgres');
let text=fs.readFileSync(path.join(__dirname,'../.env.example'),'utf8');
for (const key of ['POSTGRES_ADMIN_PASSWORD','APP_DB_PASSWORD','JWT_SECRET','PGADMIN_PASSWORD']) text=text.replace(new RegExp('^'+key+'=$','m'),key+'='+randomBytes(48).toString('hex'));
fs.writeFileSync(target,text,{flag:'wx',mode:0o600});
console.log('Created '+target+'. Existing settings were not overwritten. Open it privately to set the pgAdmin email and any SMTP settings.');

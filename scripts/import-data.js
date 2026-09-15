'use strict';
// One-time import, before starting the application. Run as root inside Docker.
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(process.argv[2] || '/migration');
const target = path.resolve(process.env.DATA_DIR || '/app/data');
if (source === target) throw new Error('Source and destination must be different.');
const files = ['users.json','database.json','budget.json'];
for (const name of files) {
    JSON.parse(fs.readFileSync(path.join(source, name), 'utf8'));
    if (fs.existsSync(path.join(target, name))) throw new Error('Destination contains existing data. Import only into a new volume.');
}
const uploads = path.join(target, 'uploads');
if (fs.existsSync(uploads) && fs.readdirSync(uploads).length) throw new Error('Destination uploads are not empty.');
fs.mkdirSync(target, {recursive:true});
for (const name of files) fs.copyFileSync(path.join(source, name), path.join(target, name), fs.constants.COPYFILE_EXCL);
fs.mkdirSync(uploads, {recursive:true});
if (fs.existsSync(path.join(source, 'uploads'))) fs.cpSync(path.join(source,'uploads'), uploads, {recursive:true, force:false, errorOnExist:true});
if (process.platform === 'linux' && process.getuid?.() === 0) {
    function own(directory) {
        fs.chownSync(directory, 1000, 1000);
        for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Symbolic links are not supported in imported data.');
            if (entry.isDirectory()) own(file); else {fs.chownSync(file,1000,1000);fs.chmodSync(file,0o600);}
        }
    }
    own(target);
}
console.log('Imported users, plans, budgets and uploads. Source data was not modified.');

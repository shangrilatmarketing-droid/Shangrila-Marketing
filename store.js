'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { blankBudget } = require('./domain');

function createStore(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const file = name => path.join(directory, name + '.json');
    function write(name, data) {
        const target = file(name);
        const temp = target + '.' + randomUUID() + '.tmp';
        try {
            const fd = fs.openSync(temp, 'wx', 0o600);
            try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
            finally { fs.closeSync(fd); }
            fs.renameSync(temp, target);
        } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }
    function read(name) { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
    for (const [name, value] of Object.entries({users: [], database: [], budget: {}, reminders: {}})) {
        if (!fs.existsSync(file(name))) write(name, value);
    }
    if (!Array.isArray(read('users'))) throw new Error('users.json must contain an array.');
    const legacy = read('database');
    if (!Array.isArray(legacy)) {
        if (!legacy || typeof legacy !== 'object') throw new Error('Invalid database.json.');
        fs.copyFileSync(file('database'), file('database') + '.pre-migration-' + Date.now() + '.bak');
        write('database', Object.entries(legacy).flatMap(([email, plans]) => Array.isArray(plans) ? plans.map(p => ({ ...p, createdBy:p.createdBy || email })) : []));
    }
    if (!Object.keys(read('budget')).length) {
        const users = read('users');
        const owner = users.find(u => u.isAdmin && u.annualBudget) || users.find(u => u.annualBudget);
        write('budget', { ...blankBudget(), ...owner?.annualBudget });
    }
    const revision = plans => '"' + createHash('sha256').update(JSON.stringify(plans)).digest('hex') + '"';
    return {read, write, revision, directory};
}
module.exports = {createStore};

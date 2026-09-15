'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sandbox = vm.createContext({Intl,Date});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui.js'),'utf8') + '\nthis.reorder = UI.reorderVisible;',sandbox);

test('reordering filtered plans preserves hidden positions, contents and dates', () => {
    const plans = [{id:'a',date:'2026-10-15'}, {id:'hidden-company'}, {id:'b',date:'2026-09-01'}, {id:'hidden-status'}, {id:'c',date:'2026-09-25'}];
    const before = JSON.stringify(plans);
    const reordered = sandbox.reorder(plans,['c','a','b']);
    assert.deepEqual(reordered.map(p=>p.id),['c','hidden-company','a','hidden-status','b']);
    assert.equal(reordered[1],plans[1]);
    assert.equal(reordered[3],plans[3]);
    assert.equal(reordered[0].date,'2026-09-25');
    assert.equal(JSON.stringify(plans),before);
});
test('reordering works in both directions and keeps new or unselected plans', () => {
    const plans = [{id:'a'},{id:'b'},{id:'c'},{id:'new'}];
    const down = sandbox.reorder(plans,['b','c','a']);
    assert.deepEqual(down.map(p=>p.id),['b','c','a','new']);
    const up = sandbox.reorder(down,['a','b','c']);
    assert.deepEqual(up.map(p=>p.id),['a','b','c','new']);
    assert.deepEqual(sandbox.reorder(plans,[]),plans);
});
test('reordering rejects stale or duplicate IDs instead of dropping records', () => {
    const plans = [{id:'a'},{id:'b'}];
    assert.throws(()=>sandbox.reorder(plans,['a','missing']),/list changed/);
    assert.throws(()=>sandbox.reorder(plans,['a','a']),/list changed/);
});

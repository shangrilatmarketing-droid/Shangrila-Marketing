'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {nextDate, advanceRecurring, validatePlans, validDate, dateInZone, escapeHtml, money} = require('../domain');

test('monthly and quarterly schedules clamp month ends and retain the original day', () => {
    assert.equal(nextDate('2024-01-31','monthly',31),'2024-02-29');
    assert.equal(nextDate('2024-02-29','monthly',31),'2024-03-31');
    assert.equal(nextDate('2025-01-31','quarterly',31),'2025-04-30');
    assert.equal(nextDate('2025-12-28','weekly'),'2026-01-04');
});
test('recurring maintenance preserves history, respects repeat limits and is idempotent', () => {
    const plans = [{id:'original',date:'2026-01-31',timeframe:'monthly',status:'pending',repetitionsLeft:2,cost:25}];
    assert.equal(advanceRecurring(plans,'2026-04-01'),true);
    assert.deepEqual(plans.map(p => p.date),['2026-01-31','2026-02-28','2026-03-31']);
    assert.deepEqual(plans.map(p => p.repetitionsLeft),[2,1,0]);
    assert.equal(advanceRecurring(plans,'2026-04-01'),false);
    assert.equal(plans[0].date,'2026-01-31');
});
test('junk and archived recurrences are never resurrected; a completed occurrence schedules a pending successor', () => {
    const plans = ['junk','archived'].map(status => ({status,id:status,date:'2026-01-01',timeframe:'weekly'}));
    assert.equal(advanceRecurring(plans,'2026-02-01'),false);
    plans.push({id:'completed',date:'2026-02-01',status:'completed',timeframe:'weekly',repetitionsLeft:1});
    advanceRecurring(plans,'2026-02-01');
    assert.equal(plans.at(-1).date,'2026-02-08');
    assert.equal(plans.at(-1).status,'pending');
});
test('dates and daily metrics use Nepal local time across UTC midnight', () => {
    assert.deepEqual(dateInZone(new Date('2026-09-13T20:00:00Z')), {date:'2026-09-14',time:'01:45'});
    assert.equal(validDate('2026-02-30'),false);
    assert.equal(validDate('2024-02-29'),true);
});
test('validation rejects malformed input and preserves server-owned plan metadata', () => {
    const p = {id:'one',title:' Test ',date:'2026-09-20',company:'SOTC',timeframe:'event',cost:'125.25',status:'pending',createdBy:'forged@example.com'};
    const [saved] = validatePlans([p],[],'actual@example.com');
    assert.equal(saved.createdBy,'actual@example.com');
    assert.equal(saved.cost,125.25);
    assert.equal(saved.title,'Test');
    for (const bad of [{title:' '},{cost:-1},{cost:'Infinity'},{date:'2026-02-30'},{time:'25:00'},{company:'Unknown'},{repetitionsLeft:1.2},{photoUrl:'javascript:alert(1)'}]) assert.throws(() => validatePlans([{...p,...bad}],[],'actual@example.com'));
    assert.throws(() => validatePlans([p,p],[],'actual@example.com'));
    assert.equal(money('123.45'),123.45);
    assert.match(escapeHtml('<img src=x onerror="alert(1)">'),/^&lt;img/);
});
test('browser currency, escaping and date helpers handle string costs and midnight', () => {
    const sandbox = vm.createContext({Intl,Date});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui.js'),'utf8') + '\nthis.testUI = UI;',sandbox);
    assert.equal(sandbox.testUI.money('1234.5'),'NPR 1,234.50');
    assert.equal(sandbox.testUI.money(-50),'NPR -50.00');
    assert.equal(sandbox.testUI.escape('<script>'), '&lt;script&gt;');
    assert.equal(sandbox.testUI.localNow('Asia/Kathmandu',new Date('2026-09-13T20:00:00Z')).date,'2026-09-14');
    assert.equal(sandbox.testUI.newId({randomUUID:() => 'native-id'}),'native-id');
    assert.match(sandbox.testUI.newId({}),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mergeCollections}=require('../scripts/merge-json');

test('guarded legacy merge retains current collisions and restores missing rows',()=>{
    const snapshot={
        users:[{email:'same@example.test',password:'legacy'},{email:'legacy@example.test',password:'legacy-only'}],
        plans:[{id:'same',title:'legacy'},{id:'legacy-only',title:'legacy only'}],
        budget:{SOTC:1000,STT:2000},reminders:{'same@example.test':'2026-08-01','legacy@example.test':'2026-08-02'}
    };
    const current={
        users:[{email:'same@example.test',password:'current'},{email:'new@example.test',password:'new'}],
        plans:[{id:'same',title:'current'},{id:'new-only',title:'new only'}],
        budget:{SOTC:9999,STT:0},reminders:{'same@example.test':'2026-09-01','new@example.test':'2026-09-02'}
    };
    const merged=mergeCollections(snapshot,current,['SOTC']);
    assert.deepEqual(merged.users.map(user=>user.email),['same@example.test','legacy@example.test','new@example.test']);
    assert.equal(merged.users[0].password,'current');
    assert.deepEqual(merged.plans.map(plan=>plan.id),['same','legacy-only','new-only']);
    assert.equal(merged.plans[0].title,'current');
    assert.deepEqual(merged.budget,{SOTC:9999,STT:2000});
    assert.deepEqual(merged.reminders,{'same@example.test':'2026-09-01','legacy@example.test':'2026-08-02','new@example.test':'2026-09-02'});
});

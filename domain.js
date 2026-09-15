'use strict';

const { randomUUID } = require('node:crypto');
const COMPANIES = ['Himalayan Journeys', 'SOTC', 'Europamundo', 'APG', 'UPS'];
const TIMEFRAMES = ['event', 'weekly', 'monthly', 'quarterly'];
const STATUSES = ['pending', 'completed', 'junk', 'archived'];
const blankBudget = () => Object.fromEntries(COMPANIES.map(name => [name, 0]));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '1900-01-01' && value <= '9998-12-31' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validTime(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function money(value) {
    const number = value === '' || value == null ? 0 : Number(value);
    if (!['number', 'string', 'undefined'].includes(typeof value) && value !== null) fail('Enter a valid amount.');
    if (!Number.isFinite(number) || number < 0 || number > 1e12) fail('Amounts must be between 0 and 1,000,000,000,000 NPR.');
    return Math.round(number * 100) / 100;
}
function cleanEmail(value) {
    if (typeof value !== 'string') fail('Enter a valid email address.');
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) fail('Enter a valid email address.');
    return email;
}
function validPassword(value) {
    if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 72) fail('Passwords must contain at least 8 characters and at most 72 bytes.');
}
function validatePlans(input, existing, email) {
    if (!Array.isArray(input) || input.length > 20000) fail('Expected an array of up to 20,000 plans.');
    const previous = new Map(existing.map(p => [String(p.id), p]));
    const ids = new Set();
    return input.map(p => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) fail('Invalid plan.');
        const id = String(p.id || '');
        if (!/^[\w-]{1,100}$/.test(id) || ids.has(id)) fail('Each plan needs a unique ID.');
        ids.add(id);
        if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200) fail('Plan titles must contain 1–200 characters.');
        if (typeof (p.description ?? '') !== 'string' || (p.description || '').length > 5000) fail('Descriptions must be no longer than 5,000 characters.');
        if (!COMPANIES.includes(p.company) || !TIMEFRAMES.includes(p.timeframe || 'event')) fail('Choose a valid company and timeframe.');
        if (!validDate(p.date) || (p.time && !validTime(p.time))) fail('Enter a valid plan date and time.');
        if (!STATUSES.includes(p.status || 'pending')) fail('Invalid plan status.');
        const repetitions = p.repetitionsLeft == null || p.repetitionsLeft === '' ? null : Number(p.repetitionsLeft);
        if (repetitions !== null && (!Number.isInteger(repetitions) || repetitions < 0 || repetitions > 1000)) fail('Additional repeats must be a whole number from 0 to 1,000.');
        if (p.photoUrl && !/^\/uploads\/[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(p.photoUrl)) fail('Invalid photo.');
        const old = previous.get(id);
        const status = p.status || 'pending';
        const isDeleted = status === 'junk' || status === 'archived';
        return {
            id, title: p.title.trim(), description: p.description || '', company: p.company,
            date: p.date, time: p.time || '', timeframe: p.timeframe || 'event', cost: money(p.cost),
            photoUrl: p.photoUrl || null, repetitionsLeft: repetitions, status,
            createdBy: old?.createdBy || email,
            completedAt: status === 'completed' || status === 'archived' ? old?.completedAt || Date.now() : null,
            deletedAt: isDeleted ? old?.deletedAt || Date.now() : null,
            deletedBy: isDeleted ? old?.deletedBy || email : null,
            recurrenceDay: old?.date === p.date ? old?.recurrenceDay || Number(p.date.slice(-2)) : Number(p.date.slice(-2)),
            recurrenceNextId: old?.recurrenceNextId || null
        };
    });
}
function dateInZone(now = new Date(), timeZone = 'Asia/Kathmandu') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(now).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
function nextDate(date, timeframe, anchorDay = Number(date.slice(-2))) {
    const d = new Date(`${date}T12:00:00Z`);
    if (timeframe === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
    else {
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + (timeframe === 'quarterly' ? 3 : 1));
        const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        d.setUTCDate(Math.min(anchorDay, last));
    }
    return d.toISOString().slice(0, 10);
}
function advanceRecurring(plans, today) {
    let changed = false;
    // Preserve every historical occurrence; never resurrect items in Junk or the archive.
    let added = 0;
    for (let i = 0; i < plans.length && added < 1000 && plans.length < 20000; i++) {
        const p = plans[i];
        if (!['weekly', 'monthly', 'quarterly'].includes(p.timeframe) || ['junk','archived'].includes(p.status) || p.recurrenceNextId || p.repetitionsLeft === 0 || !validDate(p.date)) continue;
        if (p.date >= today && p.status !== 'completed') continue;
        const id = randomUUID();
        const anchor = p.recurrenceDay || Number(p.date.slice(-2));
        const date = nextDate(p.date, p.timeframe, anchor);
        if (!validDate(date)) continue;
        plans.push({ ...p, id, date, status:'pending', completedAt:null, deletedAt:null, deletedBy:null, notified:false,
            recurrenceDay:anchor, recurrenceNextId:null, repetitionsLeft:p.repetitionsLeft == null ? null : Math.max(0, p.repetitionsLeft - 1) });
        p.recurrenceNextId = id;
        added++;
        changed = true;
    }
    return changed;
}
module.exports = { COMPANIES, blankBudget, escapeHtml, fail, validDate, validTime, money, cleanEmail, validPassword, validatePlans, dateInZone, nextDate, advanceRecurring };

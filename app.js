'use strict';
const $ = id => document.getElementById(id);
const companies = ['Himalayan Journeys','SOTC','Europamundo','APG','UPS'];
const companyIds = ['hj','sotc','euro','apg','ups'];
const typeNames = {event:'Event', weekly:'Weekly', monthly:'Monthly', quarterly:'Quarterly'};
let plans = [], lastSaved = [], revision = null, user = null, budgets = {}, timeZone = 'Asia/Kathmandu';
let currentTab = 'dashboard', filter = 'all', editingId = null, busy = false, ready = false;
let currentModal = null, previousFocus = null;
let dragState = null, loadingPlans = false;
const escape = UI.escape;
const isPending = p => !p.status || p.status === 'pending';
const dateNow = () => UI.localNow(timeZone);
function errorToast(error) { UI.toast('Could not complete the action', error.message || 'Check your connection and try again.', true); }
function setBusy(value) {
    busy = value;
    document.querySelectorAll('[data-action], [data-drag-id], #add-plan-btn, #plan-form button[type=submit]').forEach(el => el.disabled = value || !ready || el.dataset.orderBoundary === 'true');
    $('plan-form').querySelector('[type=submit]').textContent = value ? 'Saving…' : 'Save Plan';
}
async function loadPlans() {
    loadingPlans = true;
    try {
    const response = await UI.request('/api/plans');
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('The server returned an invalid schedule.');
    plans = data;
    lastSaved = structuredClone(data);
    revision = response.headers.get('etag');
    ready = true;
    $('connection-status').textContent = 'Schedule up to date';
    $('connection-status').classList.remove('error');
    render();
    setBusy(false);
    } finally { loadingPlans = false; }
}
async function loadSettings() {
    const response = await UI.request('/api/user/settings');
    const data = await response.json();
    user = data;
    budgets = data.annualBudget || {};
    timeZone = data.timeZone || timeZone;
    UI.clearLegacy();
    $('tab-admin').classList.toggle('hidden', !user.isAdmin);
    $('current-user').textContent = user.email;
    $('digest-zone').textContent = `Times use ${timeZone.replace('_',' ')}.`;
    $('email-configuration').textContent = data.emailConfigured ? 'Daily emails include pending plans scheduled for today.' : 'Email is not configured on this server yet.';
    $('test-email-btn').disabled = !data.emailConfigured;
    populateSettings();
}
function populateSettings() {
    companies.forEach((name,i) => {
        const input = $('settings-budget-' + companyIds[i]);
        input.value = Number(budgets[name]) || 0;
        input.disabled = !user?.isAdmin;
    });
    $('settings-email-enabled').checked = user?.emailNotificationsEnabled !== false;
    $('settings-email-time').value = user?.emailNotificationTime || '10:00';
    $('budget-permission').textContent = user?.isAdmin ? 'Set the annual allocation for each company.' : 'An administrator manages the team’s annual budgets.';
}
async function savePlans(candidate) {
    if (busy || !ready) return false;
    setBusy(true);
    try {
        const response = await UI.request('/api/plans', {method:'POST', headers:{'If-Match':revision}, body:JSON.stringify(candidate)});
        const data = await response.json();
        plans = data.plans;
        lastSaved = structuredClone(plans);
        revision = response.headers.get('etag');
        render();
        $('connection-status').textContent = 'All changes saved';
        $('connection-status').classList.remove('error');
        return true;
    } catch (error) {
        plans = structuredClone(lastSaved);
        if (error.status === 409) {
            try { await loadPlans(); } catch { ready = false; }
        }
        render();
        $('connection-status').textContent = 'Changes were not saved';
        $('connection-status').classList.add('error');
        errorToast(error);
        return false;
    } finally { setBusy(false); }
}
function metrics() {
    const now = dateNow();
    const active = plans.filter(isPending);
    $('total-plans-count').textContent = active.length;
    $('due-today-count').textContent = active.filter(p => p.date === now.date).length;
    $('overdue-count').textContent = active.filter(p => p.date < now.date || (p.date === now.date && p.time && p.time < now.time)).length;
    $('completed-count').textContent = plans.filter(p => ['completed','archived'].includes(p.status)).length;
    $('budget-year').textContent = now.date.slice(0,4);
    $('company-budgets-container').innerHTML = companies.map(name => {
        const allocation = Number(budgets[name]) || 0;
        const committed = plans.filter(p => p.company === name && p.status !== 'junk' && p.date?.startsWith(now.date.slice(0,4))).reduce((sum,p) => sum + (Number(p.cost) || 0), 0);
        const remaining = allocation - committed;
        const percent = allocation > 0 ? Math.min(100, Math.max(0, committed / allocation * 100)) : committed > 0 ? 100 : 0;
        return `<article class="budget-card glass-panel ${remaining < 0 ? 'over-budget' : ''}"><div class="budget-heading"><h3>${escape(name)}</h3><i data-lucide="wallet"></i></div><p class="budget-amount">${UI.money(remaining)}</p><span class="budget-caption">${remaining < 0 ? 'Over budget' : 'Remaining'}</span><div class="budget-track" role="meter" aria-label="${escape(name)} budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span style="width:${percent}%"></span></div><dl><div><dt>Allocated</dt><dd>${UI.money(allocation)}</dd></div><div><dt>Planned & spent</dt><dd>${UI.money(committed)}</dd></div></dl></article>`;
    }).join('');
}
function render() {
    clearDrag();
    metrics();
    if (currentTab === 'admin') { UI.icons(); return; }
    const selectedCompany = $('company-filter').value;
    const query = $('plan-search').value.trim().toLowerCase();
    let visible = plans.filter(p => currentTab === 'dashboard' ? isPending(p) : p.status === currentTab);
    if (selectedCompany !== 'All') visible = visible.filter(p => p.company === selectedCompany);
    if (filter !== 'all' && currentTab === 'dashboard') visible = visible.filter(p => (p.timeframe || 'event') === filter);
    if (query) visible = visible.filter(p => [p.title,p.description,p.company,p.createdBy].some(value => String(value || '').toLowerCase().includes(query)));
    $('results-count').textContent = `${visible.length} plan${visible.length === 1 ? '' : 's'}`;
    if (!visible.length) {
        $('plans-container').innerHTML = `<div class="empty-state"><i data-lucide="${query || selectedCompany !== 'All' || filter !== 'all' ? 'search' : 'calendar-days'}"></i><h3>${ready ? 'No plans in this view' : 'Your schedule is loading'}</h3><p>${query || selectedCompany !== 'All' || filter !== 'all' ? 'Try another search or clear your filters.' : currentTab === 'dashboard' ? 'Create a plan to give your next campaign a place to start.' : 'Plans you move here will appear in this view.'}</p></div>`;
        UI.icons();
        return;
    }
    const now = dateNow();
    $('plans-container').innerHTML = visible.map((p, index) => {
        const overdue = isPending(p) && (p.date < now.date || (p.date === now.date && p.time && p.time < now.time));
        const date = new Date(`${p.date}T12:00:00`);
        const valid = !Number.isNaN(date.getTime());
        const month = valid ? date.toLocaleDateString('en', {month:'short'}) : '—';
        const day = valid ? date.getDate() : '—';
        const photo = p.photoUrl && /^\/uploads\/[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(p.photoUrl) ? `<img src="${escape(p.photoUrl)}" alt="Photo attached to ${escape(p.title)}" class="plan-thumbnail" loading="lazy">` : '';
        const button = (action, icon, label) => `<button type="button" class="icon-btn" data-action="${action}" data-id="${escape(p.id)}" title="${label}" aria-label="${label}: ${escape(p.title)}" ${busy || !ready ? 'disabled' : ''}><i data-lucide="${icon}"></i></button>`;
        let actions = '';
        if (p.status === 'junk') actions = button('recover','rotate-ccw','Restore plan') + button('delete','trash-2','Permanently delete');
        else if (p.status === 'archived') actions = button('unarchive','archive-restore','Restore to completed');
        else actions = button('complete',p.status === 'completed' ? 'rotate-ccw' : 'check',p.status === 'completed' ? 'Mark pending' : 'Mark completed') + button('edit','pencil','Edit plan') + button('delete',p.status === 'completed' ? 'archive' : 'trash-2',p.status === 'completed' ? 'Archive plan' : 'Move to Junk');
        return `<article class="plan-item glass-panel ${overdue ? 'overdue' : ''}" data-plan-id="${escape(p.id)}"><div class="plan-reorder"><button type="button" class="icon-btn order-step" data-action="move-up" data-id="${escape(p.id)}" data-order-boundary="${index === 0}" aria-label="Move up: ${escape(p.title)}" title="Move up" ${busy || !ready || index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up"></i></button><button type="button" class="icon-btn drag-handle" data-drag-id="${escape(p.id)}" aria-label="Reorder: ${escape(p.title)}" aria-describedby="reorder-help" title="Drag to reorder, or use Up and Down arrow keys" ${busy || !ready ? 'disabled' : ''}><i data-lucide="grip-vertical"></i></button><button type="button" class="icon-btn order-step" data-action="move-down" data-id="${escape(p.id)}" data-order-boundary="${index === visible.length - 1}" aria-label="Move down: ${escape(p.title)}" title="Move down" ${busy || !ready || index === visible.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down"></i></button></div><div class="plan-date-block"><span>${month}</span><strong>${day}</strong><small>${valid ? date.getFullYear() : ''}</small></div><div class="plan-details"><div class="plan-tags"><span class="plan-type-badge ${escape(p.timeframe || 'event')}">${escape(typeNames[p.timeframe] || 'Event')}</span><span class="company-badge">${escape(p.company)}</span>${overdue ? '<span class="status-badge overdue-label">Overdue</span>' : ''}</div><h3>${escape(p.title)}</h3><p class="plan-description">${escape(p.description || 'No description added.')}</p><div class="plan-meta"><span><i data-lucide="clock-3"></i>${escape(p.time || 'All day')}</span><span class="plan-cost">${UI.money(p.cost)}</span><span class="plan-creator" title="${escape(p.createdBy || '')}">By ${escape(p.createdBy || 'Unknown')}</span>${p.recurrenceNextId ? '<span>Next occurrence scheduled</span>' : ''}</div></div>${photo}<div class="plan-actions">${actions}</div></article>`;
    }).join('');
    UI.icons();
}
function visiblePlanIds() {
    return [...$('plans-container').querySelectorAll('[data-plan-id]')].map(card => card.dataset.planId);
}
function focusOrderHandle(id) {
    [...$('plans-container').querySelectorAll('[data-drag-id]')].find(button => button.dataset.dragId === String(id))?.focus({preventScroll:true});
}
async function saveOrder(ids, movedId) {
    const selected = new Set(ids);
    const original = plans.filter(plan => selected.has(String(plan.id))).map(plan => String(plan.id));
    if (ids.every((id, index) => id === original[index])) return;
    const next = UI.reorderVisible(plans, ids);
    if (await savePlans(next)) UI.toast('Order saved', `Plan moved to position ${ids.indexOf(String(movedId)) + 1} of ${ids.length} in this view.`);
    focusOrderHandle(movedId);
}
async function movePlan(id, direction) {
    if (busy || !ready || loadingPlans) return;
    const ids = visiblePlanIds();
    const from = ids.indexOf(String(id)), to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    await saveOrder(ids, id);
}
function clearDrag() {
    if (!dragState) return;
    const state = dragState;
    dragState = null;
    cancelAnimationFrame(state.frame);
    state.card.classList.remove('dragging');
    $('plans-container').classList.remove('reordering');
    document.body.classList.remove('dragging-plan');
    if ($('plans-container').hasPointerCapture(state.pointerId)) $('plans-container').releasePointerCapture(state.pointerId);
}
function positionDraggedPlan() {
    if (!dragState?.active) return;
    const container = $('plans-container'), bounds = container.getBoundingClientRect();
    dragState.valid = dragState.x >= bounds.left - 24 && dragState.x <= bounds.right + 24 && dragState.y >= bounds.top - 24 && dragState.y <= bounds.bottom + 24;
    if (!dragState.valid) return;
    const siblings = [...container.querySelectorAll('[data-plan-id]')].filter(card => card !== dragState.card);
    const target = siblings.find(card => {
        const rect = card.getBoundingClientRect();
        return dragState.y < rect.top + rect.height / 2;
    });
    if (dragState.card.nextElementSibling !== (target || null)) container.insertBefore(dragState.card, target || null);
}
function scrollDuringDrag() {
    if (!dragState?.active) return;
    const edge = 70;
    const distance = dragState.y < edge ? -Math.ceil((edge - dragState.y) / 4) : dragState.y > innerHeight - edge ? Math.ceil((dragState.y - innerHeight + edge) / 4) : 0;
    if (distance && dragState.valid) {
        window.scrollBy(0, Math.max(-20, Math.min(20, distance)));
        positionDraggedPlan();
    }
    dragState.frame = requestAnimationFrame(scrollDuringDrag);
}
async function finishDrag(cancelled = false) {
    if (!dragState) return;
    const {active, valid, id} = dragState;
    const ids = visiblePlanIds();
    clearDrag();
    if (!active) return;
    if (cancelled || !valid) { render(); focusOrderHandle(id); return; }
    await saveOrder(ids, id);
}
$('plans-container').addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-drag-id]');
    if (!handle || handle.disabled || busy || !ready || loadingPlans || !event.isPrimary || event.button !== 0) return;
    clearDrag();
    dragState = {id:handle.dataset.dragId, card:handle.closest('[data-plan-id]'), pointerId:event.pointerId,
        startX:event.clientX, startY:event.clientY, x:event.clientX, y:event.clientY, active:false, valid:true};
    handle.focus({preventScroll:true});
    $('plans-container').setPointerCapture(event.pointerId);
    event.preventDefault();
});
document.addEventListener('pointermove', event => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    dragState.x = event.clientX;
    dragState.y = event.clientY;
    if (!dragState.active) {
        if (Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < 6) return;
        dragState.active = true;
        dragState.card.classList.add('dragging');
        $('plans-container').classList.add('reordering');
        document.body.classList.add('dragging-plan');
        dragState.frame = requestAnimationFrame(scrollDuringDrag);
    }
    event.preventDefault();
    positionDraggedPlan();
}, {passive:false});
document.addEventListener('pointerup', event => {
    if (event.pointerId === dragState?.pointerId) finishDrag().catch(errorToast);
});
document.addEventListener('pointercancel', event => {
    if (event.pointerId === dragState?.pointerId) finishDrag(true).catch(errorToast);
});
$('plans-container').addEventListener('lostpointercapture', () => { if (dragState) finishDrag(true).catch(errorToast); });
$('plans-container').addEventListener('keydown', event => {
    const handle = event.target.closest('[data-drag-id]');
    if (!handle || !['ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    movePlan(handle.dataset.dragId, event.key === 'ArrowUp' ? -1 : 1).catch(errorToast);
});
addEventListener('keydown', event => { if (event.key === 'Escape' && dragState) {event.preventDefault(); finishDrag(true).catch(errorToast);} });
addEventListener('blur', () => { if (dragState) finishDrag(true).catch(errorToast); });
function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('[data-tab]').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === name);
        if (el.dataset.tab === name) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current');
    });
    $('dashboard-section').classList.toggle('hidden', name === 'admin');
    $('admin-panel').classList.toggle('hidden', name !== 'admin');
    if (name === 'admin') { loadUsers(); return; }
    const titles = {dashboard:['Upcoming plans','Plan your next move. Keep the whole team in sync.'], completed:['Completed plans','A record of the work your team has delivered.'], junk:['Junk folder','Restore a plan or permanently delete it when you are ready.'], archived:['Archived plans','Completed work, kept for your records and reports.']};
    $('page-title').textContent = titles[name][0];
    $('page-subtitle').textContent = titles[name][1];
    $('filter-tabs').classList.toggle('hidden', name !== 'dashboard');
    $('export-excel-btn').classList.toggle('hidden', !['completed','archived'].includes(name));
    $('add-plan-btn').classList.toggle('hidden', name !== 'dashboard');
    $('overview').classList.toggle('hidden', name !== 'dashboard');
    $('schedule-title').textContent = name === 'dashboard' ? 'Team schedule' : 'Plans';
    render();
}
function showModal(id) {
    currentModal = $(id);
    previousFocus = document.activeElement;
    currentModal.classList.remove('hidden');
    currentModal.classList.add('active');
    document.body.classList.add('modal-open');
    document.querySelector('.app-container').inert = true;
    currentModal.querySelector('input:not([disabled]), button').focus();
}
function closeModal() {
    if (busy) return;
    currentModal?.classList.add('hidden');
    currentModal?.classList.remove('active');
    currentModal = null;
    document.body.classList.remove('modal-open');
    document.querySelector('.app-container').inert = false;
    previousFocus?.focus();
}
function updateTimeframe() {
    const recurring = $('plan-timeframe').value !== 'event';
    $('recurring-options').classList.toggle('hidden', !recurring);
    $('time-group').classList.toggle('hidden', recurring);
    $('plan-date-label').textContent = recurring ? 'First / target date' : 'Date';
    if (recurring) $('plan-time').value = '';
    $('plan-repetitions-label').textContent = 'Additional repeats';
}
function editPlan(id = null) {
    editingId = id;
    $('plan-form').reset();
    const p = id ? plans.find(p => p.id === id) : null;
    if (id && !p) return;
    $('plan-modal-title').textContent = p ? 'Edit plan' : 'Create a plan';
    $('plan-title').value = p?.title || '';
    $('plan-desc').value = p?.description || '';
    $('plan-company').value = p?.company || (companies.includes($('company-filter').value) ? $('company-filter').value : companies[0]);
    $('plan-timeframe').value = p?.timeframe || 'event';
    $('plan-date').value = p?.date || dateNow().date;
    $('plan-time').value = p?.time || '';
    $('plan-cost').value = p?.cost ?? '';
    $('plan-repetitions').value = p?.repetitionsLeft ?? '';
    $('photo-current').textContent = p?.photoUrl ? 'This plan already has a photo. Choose a file to replace it.' : 'PNG, JPEG, GIF or WebP · up to 5 MB';
    $('plan-repetitions').disabled = Boolean(p?.recurrenceNextId);
    $('recurrence-help').textContent = p?.recurrenceNextId ? 'The next occurrence already exists. Edit that plan to change future repeats.' : 'Blank repeats indefinitely; 0 means no additional repeats. Each occurrence is kept in the schedule.';
    updateTimeframe();
    showModal('plan-modal');
    $('plan-title').focus();
}
$('plan-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return errorToast(new Error('Please wait for the current change to finish.'));
    if (!ready) return errorToast(new Error('The schedule is not ready. Refresh the page and sign in again.'));
    if (!$('plan-form').reportValidity()) return errorToast(new Error('Complete the highlighted task fields before saving.'));
    const old = editingId ? plans.find(p => p.id === editingId) : null;
    if (editingId && !old) return errorToast(new Error('This plan no longer exists. Close this form and reload the schedule.'));
    try {
        const candidate = {...old, id:old?.id || UI.newId(), title:$('plan-title').value.trim(), description:$('plan-desc').value.trim(),
            company:$('plan-company').value, timeframe:$('plan-timeframe').value, date:$('plan-date').value,
            time:$('plan-timeframe').value === 'event' ? $('plan-time').value : '', cost:Number($('plan-cost').value || 0),
            repetitionsLeft:$('plan-timeframe').value === 'event' ? 0 : $('plan-repetitions').value === '' ? null : Number($('plan-repetitions').value),
            photoUrl:old?.photoUrl || null, status:old?.status || 'pending'};
        if (!candidate.title) throw new Error('Enter a plan title.');
        const file = $('plan-photo').files[0];
        if (file) {
            if (file.size > 5 * 1024 * 1024) throw new Error('Photos must be no larger than 5 MB.');
            setBusy(true);
            const data = new FormData(); data.append('photo', file);
            const response = await UI.request('/api/upload', {method:'POST', body:data});
            candidate.photoUrl = (await response.json()).photoUrl;
            setBusy(false);
        }
        const next = old ? plans.map(p => p.id === editingId ? candidate : p) : [...plans,candidate];
        if (await savePlans(next)) { closeModal(); UI.toast(old ? 'Plan updated' : 'Plan created', candidate.title); }
    } catch (error) { errorToast(error); } finally { setBusy(false); }
});
$('plans-container').addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || busy || !ready) return;
    const id = button.dataset.id, action = button.dataset.action;
    const plan = plans.find(p => String(p.id) === id);
    if (!plan) return;
    if (action === 'move-up' || action === 'move-down') { await movePlan(plan.id, action === 'move-up' ? -1 : 1); return; }
    if (action === 'edit') { editPlan(plan.id); return; }
    const next = structuredClone(plans), updated = next.find(p => p.id === plan.id);
    if (action === 'complete') updated.status = plan.status === 'completed' ? 'pending' : 'completed';
    if (action === 'recover') updated.status = 'pending';
    if (action === 'unarchive') updated.status = 'completed';
    if (action === 'delete') {
        if (plan.status === 'junk') {
            if (!confirm(`Permanently delete “${plan.title}”? This cannot be undone.`)) return;
            next.splice(next.indexOf(updated), 1);
        } else updated.status = plan.status === 'completed' ? 'archived' : 'junk';
    }
    if (await savePlans(next)) UI.toast('Plan updated', action === 'delete' && plan.status !== 'junk' ? `Moved to ${plan.status === 'completed' ? 'the archive' : 'Junk'}. You can restore it from that view.` : 'Your change has been saved.');
});
$('save-settings-btn').addEventListener('click', async () => {
    const inputs = [...$('settings-modal').querySelectorAll('input:not([disabled])')];
    if (inputs.some(input => !input.reportValidity())) return;
    const button = $('save-settings-btn');
    if (button.disabled) return;
    button.disabled = true;
    try {
        const payload = {emailNotificationsEnabled:$('settings-email-enabled').checked, emailNotificationTime:$('settings-email-time').value};
        if (user.isAdmin) payload.annualBudget = Object.fromEntries(companies.map((c,i) => [c,Number($('settings-budget-' + companyIds[i]).value || 0)]));
        const response = await UI.request('/api/user/settings', {method:'POST', body:JSON.stringify(payload)});
        user = await response.json(); budgets = user.annualBudget;
        render(); closeModal(); UI.toast('Settings saved','Your preferences are up to date.');
    } catch (error) { errorToast(error); } finally { button.disabled = false; }
});
$('test-email-btn').addEventListener('click', async () => {
    $('test-email-btn').disabled = true;
    try { await UI.request('/api/test-email', {method:'POST'}); UI.toast('Email sent','Check your inbox for the test notification.'); }
    catch (error) { errorToast(error); } finally { $('test-email-btn').disabled = !user?.emailConfigured; }
});
$('export-excel-btn').addEventListener('click', async () => {
    const button = $('export-excel-btn'); button.disabled = true;
    try {
        const response = await UI.request('/api/export-report');
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = 'Completed_Tasks_Report.xlsx';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        UI.toast('Report downloaded','Completed and archived plans, with all costs in NPR.');
    } catch (error) { errorToast(error); } finally { button.disabled = false; }
});
async function loadUsers() {
    const body = $('users-table-body');
    body.innerHTML = '<tr><td colspan="4">Loading accounts…</td></tr>';
    try {
        const response = await UI.request('/api/admin/users');
        const users = await response.json();
        body.innerHTML = users.map(u => `<tr><td class="user-email">${escape(u.email)}${u.email === user.email ? '<small>You</small>' : ''}</td><td><span class="company-badge">${u.isAdmin ? 'Admin' : 'Member'}</span></td><td><span class="status-badge ${u.isApproved ? 'approved' : 'overdue-label'}">${u.isApproved ? 'Approved' : 'Pending'}</span></td><td><div class="user-actions"><button class="secondary-btn" data-user-action="reset-password" data-email="${escape(u.email)}">Reset password</button>${u.email === user.email ? '' : `<button class="secondary-btn" data-user-action="toggle-approval" data-email="${escape(u.email)}">${u.isApproved ? 'Revoke approval' : 'Approve'}</button><button class="secondary-btn" data-user-action="toggle-role" data-email="${escape(u.email)}">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>`}</div></td></tr>`).join('');
    } catch (error) { body.innerHTML = '<tr><td colspan="4">Could not load accounts. Use Refresh to try again.</td></tr>'; errorToast(error); }
}
$('users-table-body').addEventListener('click', async event => {
    const button = event.target.closest('[data-user-action]');
    if (!button) return;
    const action = button.dataset.userAction, targetEmail = button.dataset.email;
    if (action === 'reset-password') {
        $('reset-email').textContent = targetEmail;
        $('reset-password-form').dataset.email = targetEmail;
        $('reset-password-form').reset();
        showModal('reset-modal'); return;
    }
    if (!confirm(`${button.textContent} for ${targetEmail}?`)) return;
    button.disabled = true;
    try { await UI.request('/api/admin/' + action, {method:'POST', body:JSON.stringify({targetEmail})}); await loadUsers(); UI.toast('Account updated',targetEmail); }
    catch (error) { errorToast(error); button.disabled = false; }
});
$('reset-password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const newPassword = $('new-password').value;
    if (newPassword !== $('confirm-password').value) return errorToast(new Error('The passwords do not match.'));
    const button = event.target.querySelector('[type=submit]'); button.disabled = true;
    try { await UI.request('/api/admin/reset-password', {method:'POST', body:JSON.stringify({targetEmail:event.target.dataset.email,newPassword})}); closeModal(); UI.toast('Password reset','Existing sessions for this account have been revoked.'); }
    catch (error) { errorToast(error); } finally { button.disabled = false; }
});
function checkReminders() {
    if (!ready || !user) return;
    const now = dateNow();
    for (const p of plans.filter(isPending)) {
        if (p.date !== now.date) continue;
        const minutes = time => Number(time.slice(0,2))*60 + Number(time.slice(3));
        const difference = minutes(p.time || '10:00') - minutes(now.time);
        if (difference > 15 || difference < -5) continue;
        const key = `reminder:${user.email}:${p.id}:${p.date}:${p.time || 'all'}`;
        if (sessionStorage.getItem(key)) continue;
        sessionStorage.setItem(key,'1');
        UI.toast('Plan reminder', `${p.title} · ${p.time || 'Today'}`);
        if ('Notification' in window && Notification.permission === 'granted') {
            try { new Notification('Shangrila Tours', {body:p.title, icon:'/logo.png'}); } catch { /* In-app reminder remains visible. */ }
        }
    }
}
$('enable-browser-notifications').addEventListener('click', async () => {
    if (!('Notification' in window)) return UI.toast('Notifications unavailable','This browser does not support desktop notifications.',true);
    try { const permission = await Notification.requestPermission(); UI.toast('Browser notifications',permission === 'granted' ? 'Desktop reminders are enabled while this page is open.' : 'You can still see reminders in the app.'); }
    catch (error) { errorToast(error); }
});
$('logout-btn').addEventListener('click', async () => {
    try { await UI.request('/api/logout',{method:'POST'}); UI.clearLegacy(); window.location.replace('/login.html'); }
    catch (error) { errorToast(error); }
});
$('add-plan-btn').addEventListener('click', () => editPlan());
$('plan-timeframe').addEventListener('change',updateTimeframe);
$('settings-nav-btn').addEventListener('click', () => { populateSettings(); showModal('settings-modal'); });
$('refresh-users-btn').addEventListener('click',loadUsers);
$('company-filter').addEventListener('change',render);
$('plan-search').addEventListener('input',render);
$('refresh-plans-btn').addEventListener('click', async () => {
    if (busy) return;
    try { await loadSettings(); await loadPlans(); } catch (error) { errorToast(error); }
});
$('filter-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(el => {el.classList.toggle('active',el === button); el.setAttribute('aria-pressed',String(el === button));});
    render();
});
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click',() => switchTab(button.dataset.tab));
for (const button of document.querySelectorAll('[data-close-modal]')) button.addEventListener('click',closeModal);
for (const overlay of document.querySelectorAll('.modal-overlay')) overlay.addEventListener('click',event => {if (event.target === overlay) closeModal();});
addEventListener('keydown', event => {
    if (!currentModal) return;
    if (event.key === 'Escape') {event.preventDefault(); closeModal();}
    if (event.key === 'Tab') {
        const focusable = [...currentModal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href]')].filter(el => el.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
    }
});
async function init() {
    UI.icons(); setBusy(false);
    try { await loadSettings(); await loadPlans(); checkReminders(); }
    catch (error) { $('connection-status').textContent = 'Could not load the schedule. Select Refresh to retry.'; $('connection-status').classList.add('error'); errorToast(error); }
}
setInterval(async () => {
    if (busy || dragState || currentModal || document.hidden || !ready) return;
    try { await loadPlans(); checkReminders(); } catch { $('connection-status').textContent = 'Connection lost. Select Refresh to retry.'; $('connection-status').classList.add('error'); }
}, 30000);
init();

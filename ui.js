'use strict';
const UI = {
    reorderVisible(plans, orderedIds) {
        const ids = orderedIds.map(String);
        const selected = new Set(ids);
        const byId = new Map(plans.map(plan => [String(plan.id), plan]));
        if (selected.size !== ids.length || ids.some(id => !byId.has(id))) throw new Error('The plan list changed. Refresh and try again.');
        let position = 0;
        // Replace only visible slots, leaving filtered-out plans in their original positions.
        return plans.map(plan => selected.has(String(plan.id)) ? byId.get(ids[position++]) : plan);
    },
    escape(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); },
    money(value) { return 'NPR ' + new Intl.NumberFormat('en-NP', {minimumFractionDigits:2, maximumFractionDigits:2}).format(Number(value) || 0); },
    localNow(zone = 'Asia/Kathmandu', now = new Date()) {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(now).map(p => [p.type,p.value]));
        return {date:`${p.year}-${p.month}-${p.day}`, time:`${p.hour}:${p.minute}`};
    },
    icons() { window.lucide?.createIcons(); },
    toast(title, message, error = false) {
        const toast = document.createElement('div');
        toast.className = 'toast' + (error ? ' urgent' : '');
        toast.setAttribute('role', error ? 'alert' : 'status');
        toast.innerHTML = `<i data-lucide="${error ? 'alert-circle' : 'check-circle'}"></i><div><strong>${UI.escape(title)}</strong><p>${UI.escape(message)}</p></div><button type="button" class="icon-btn" aria-label="Dismiss notification"><i data-lucide="x"></i></button>`;
        toast.querySelector('button').onclick = () => toast.remove();
        document.getElementById('toast-container').append(toast);
        UI.icons();
        setTimeout(() => toast.remove(), error ? 10000 : 5000);
    },
    clearLegacy() { ['token','isAdmin','email','planSync_plans','planSync_lastDigest'].forEach(k => localStorage.removeItem(k)); },
    async request(url, options = {}) {
        const token = localStorage.getItem('token');
        const headers = new Headers(options.headers);
        if (token) headers.set('Authorization', 'Bearer ' + token);
        if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type','application/json');
        const response = await fetch(url, {...options, headers, credentials:'same-origin', cache:'no-store'});
        if (response.status === 401 && !url.endsWith('/login')) {
            UI.clearLegacy();
            window.location.replace('/login.html');
            throw new Error('Please sign in again.');
        }
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            const error = new Error(data.error || 'The request failed. Please try again.');
            error.status = response.status;
            throw error;
        }
        return response;
    }
};

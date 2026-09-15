'use strict';
UI.icons();
for (const mode of ['login','register']) {
    const form = document.getElementById(mode + '-form');
    if (!form) continue;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button[type=submit]');
        if (button.disabled) return;
        const email = document.getElementById(mode + '-email').value.trim();
        const password = document.getElementById(mode + '-password').value;
        const original = button.innerHTML;
        button.disabled = true;
        button.textContent = mode === 'login' ? 'Signing in…' : 'Creating account…';
        try {
            const response = await UI.request('/api/' + mode, {method:'POST', body:JSON.stringify({email,password})});
            const data = await response.json();
            if (mode === 'login') {UI.clearLegacy(); window.location.replace('/index.html'); return;}
            UI.toast('Account created',data.message);
            form.reset();
            document.querySelector('.auth-subtitle').textContent = data.message;
            document.querySelector('.auth-links a').focus();
        } catch (error) { UI.toast(mode === 'login' ? 'Could not sign in' : 'Could not create account', error.message, true); }
        finally {button.disabled = false; button.innerHTML = original; UI.icons();}
    });
}

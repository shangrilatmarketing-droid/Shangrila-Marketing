#!/usr/bin/env python3
"""Configure Gmail for the installed planner without pasting secrets into commands."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import warnings

from deploy import GitDeployment, deployment_lock, legacy


SMTP_CHECK = r"""
const fs = require('node:fs');
const nodemailer = require('nodemailer');
(async () => {
    const {settings, live} = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (live && Object.entries(settings).some(([key, value]) => process.env[key] !== value)) {
        process.stdout.write(JSON.stringify({ok:false, code:'SETTINGS_NOT_APPLIED'}));
        return;
    }
    const e = live ? process.env : settings;
    const smtp = nodemailer.createTransport({
        host:e.SMTP_HOST, port:Number(e.SMTP_PORT), secure:e.SMTP_SECURE === 'true',
        auth:{user:e.SMTP_USER, pass:e.SMTP_PASS},
        connectionTimeout:10000, greetingTimeout:10000, socketTimeout:20000,
        logger:false, debug:false
    });
    try {
        await smtp.verify();
        process.stdout.write(JSON.stringify({ok:true}));
    } catch (error) {
        const allowed = ['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS'];
        process.stdout.write(JSON.stringify({ok:false,
            code:allowed.includes(error.code) ? error.code : 'SMTP_ERROR',
            smtpCode:Number(error.responseCode) || null}));
    } finally { smtp.close(); }
})().catch(() => {
    process.stdout.write(JSON.stringify({ok:false, code:'CHECK_FAILED'}));
});
"""


def read_password():
    if not sys.stdin.isatty():
        raise RuntimeError('Run this script directly in the Linux terminal; do not pipe input into it.')
    while True:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                value = ''.join(getpass.getpass('Google App Password (hidden; paste then press Enter): ').split())
        except getpass.GetPassWarning:
            raise RuntimeError('This terminal cannot hide password input. No settings were changed.') from None
        if re.fullmatch(r'[A-Za-z0-9]{16}', value):
            return value
        print('Expected the 16-character App Password from Google. Try again, or press Ctrl+C to cancel.', flush=True)


def verify_smtp(deployment, settings, live=False):
    identifier = deployment.compose('ps', '-q', 'app').stdout.strip()
    if not identifier or len(identifier.splitlines()) != 1:
        raise RuntimeError('Expected exactly one running planner app.')
    try:
        # Credentials travel over stdin, never in shell history, argv or log output.
        result = subprocess.run(
            ['docker', 'exec', '-i', identifier, '/usr/local/bin/node', '-e', SMTP_CHECK],
            input=json.dumps({'settings': settings, 'live': live}),
            capture_output=True, text=True, timeout=50,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError('Gmail verification timed out. Check the server connection.') from None
    try:
        report = json.loads(result.stdout) if result.returncode == 0 else {}
    except ValueError:
        report = {}
    if report.get('ok') is True:
        return
    code = report.get('code')
    if code == 'EAUTH':
        raise RuntimeError('Gmail rejected the credentials. Use an App Password created by the sender account shown above.')
    if code == 'SETTINGS_NOT_APPLIED':
        raise RuntimeError('The running app did not load the new email settings.')
    safe_code = code if code in ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS'] else 'CHECK_FAILED'
    raise RuntimeError('Gmail verification failed (' + safe_code + ').')


def atomic_write(path, text):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.email-settings-')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def configure(deployment, sender, password):
    settings = {
        'SMTP_HOST': 'smtp.gmail.com', 'SMTP_PORT': '465', 'SMTP_SECURE': 'true',
        'SMTP_USER': sender, 'SMTP_PASS': password, 'SMTP_FROM': sender,
    }
    print('Checking Gmail login before changing settings...', flush=True)
    verify_smtp(deployment, settings)
    print('Gmail accepted the credentials. Applying them to the planner app...', flush=True)
    path = deployment.root / '.app.env'
    original = path.read_text(encoding='utf-8')
    original_runtime = dict(deployment.runtime)
    try:
        deployment.runtime.update(settings)
        atomic_write(path, legacy.raw_env(deployment.runtime))
        deployment.replace_app()
        verify_smtp(deployment, settings, live=True)
    except BaseException:
        atomic_write(path, original)
        deployment.runtime = original_runtime
        try:
            deployment.replace_app()
        except Exception:
            raise RuntimeError('Email setup failed. Previous settings were restored to disk, but restarting the app needs attention.') from None
        print('Previous app settings were restored.', flush=True)
        raise
    finally:
        deployment.verify_unrelated()
    print('DONE. Gmail login verified in the running app. Open Settings and click Send test email.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sender', required=True, help='Google account that created the App Password.')
    args = parser.parse_args()
    sender = args.sender.strip().lower()
    if not re.fullmatch(r'[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+', sender):
        raise RuntimeError('Enter a valid sender email address.')
    if sys.platform != 'linux':
        raise RuntimeError('Run this helper on the Linux server.')
    os.umask(0o077)
    deployment = GitDeployment()
    with deployment_lock(deployment.root):
        deployment.installed()
        print('Sender account: ' + sender, flush=True)
        configure(deployment, sender, read_password())


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nCancelled.', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('STOPPED: ' + str(error), file=sys.stderr)
        sys.exit(1)

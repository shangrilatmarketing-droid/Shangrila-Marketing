import contextlib
import getpass
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import warnings

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import configure_email as setup


class EmailSetupTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.original = 'JWT_SECRET=fixture-secret\nSMTP_PASS=old-password\n'
        (self.root / '.app.env').write_text(self.original, encoding='utf-8')
        self.deployment = SimpleNamespace(
            root=self.root,
            runtime={'JWT_SECRET': 'fixture-secret', 'SMTP_PASS': 'old-password'},
            replace_app=Mock(), verify_unrelated=Mock(),
            compose=Mock(return_value=SimpleNamespace(stdout='planner-id\n')),
        )

    def test_bad_credentials_leave_settings_and_containers_untouched(self):
        with patch.object(setup, 'verify_smtp', side_effect=RuntimeError('Gmail rejected credentials')):
            with self.assertRaisesRegex(RuntimeError, 'Gmail rejected'):
                setup.configure(self.deployment, 'sender@example.test', 'abcdefghijklmnop')
        self.assertEqual((self.root / '.app.env').read_text(), self.original)
        self.deployment.replace_app.assert_not_called()

    def test_applied_credentials_are_verified_and_other_settings_retained(self):
        events = []
        self.deployment.replace_app.side_effect = lambda: events.append('replace')
        def verify(deployment, settings, live=False):
            events.append('live-check' if live else 'preview')
            if not live:
                self.assertEqual((self.root / '.app.env').read_text(), self.original)
        with patch.object(setup, 'verify_smtp', side_effect=verify):
            setup.configure(self.deployment, 'sender@example.test', 'abcdefghijklmnop')
        self.assertEqual(events, ['preview', 'replace', 'live-check'])
        self.assertEqual(self.deployment.runtime['JWT_SECRET'], 'fixture-secret')
        self.assertEqual(self.deployment.runtime['SMTP_PASS'], 'abcdefghijklmnop')
        self.assertEqual(self.deployment.runtime['SMTP_SECURE'], 'true')
        self.deployment.verify_unrelated.assert_called_once()

    def test_failed_live_check_restores_previous_configuration(self):
        with patch.object(setup, 'verify_smtp', side_effect=[None, RuntimeError('live check failed')]):
            with self.assertRaisesRegex(RuntimeError, 'live check failed'):
                setup.configure(self.deployment, 'sender@example.test', 'abcdefghijklmnop')
        self.assertEqual((self.root / '.app.env').read_text(), self.original)
        self.assertEqual(self.deployment.runtime['SMTP_PASS'], 'old-password')
        self.assertEqual(self.deployment.replace_app.call_count, 2)

    def test_password_is_sent_only_on_stdin_and_provider_errors_are_redacted(self):
        password = 'abcdefghijklmnop'
        settings = {'SMTP_PASS': password}
        result = SimpleNamespace(returncode=0, stdout=json.dumps({'ok': False, 'code': password}))
        with patch.object(setup.subprocess, 'run', return_value=result) as run:
            with self.assertRaisesRegex(RuntimeError, 'CHECK_FAILED') as error:
                setup.verify_smtp(self.deployment, settings)
        self.assertNotIn(password, str(run.call_args.args))
        self.assertNotIn(password, str(error.exception))
        self.assertEqual(json.loads(run.call_args.kwargs['input'])['settings'], settings)
        self.assertEqual(run.call_args.args[0][:4], ['docker', 'exec', '-i', 'planner-id'])

    def test_password_prompt_retries_then_accepts_grouped_password(self):
        output = io.StringIO()
        with patch.object(setup.sys.stdin, 'isatty', return_value=True), \
                patch.object(setup.getpass, 'getpass', side_effect=['oops', 'abcd efgh ijkl mnop']), \
                contextlib.redirect_stdout(output):
            self.assertEqual(setup.read_password(), 'abcdefghijklmnop')
        self.assertNotIn('oops', output.getvalue())
        self.assertNotIn('abcd', output.getvalue())

    def test_password_prompt_never_falls_back_to_echoed_input(self):
        def unsafe_prompt(*args):
            warnings.warn('Cannot hide input', getpass.GetPassWarning)
            self.fail('Echoed password input was reached')
        with patch.object(setup.sys.stdin, 'isatty', return_value=True), \
                patch.object(setup.getpass, 'getpass', side_effect=unsafe_prompt):
            with self.assertRaisesRegex(RuntimeError, 'cannot hide password'):
                setup.read_password()

    def test_piped_input_is_refused(self):
        with patch.object(setup.sys.stdin, 'isatty', return_value=False), \
                patch.object(setup.getpass, 'getpass') as prompt:
            with self.assertRaisesRegex(RuntimeError, 'do not pipe'):
                setup.read_password()
        prompt.assert_not_called()


if __name__ == '__main__':
    unittest.main()

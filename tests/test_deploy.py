"""Read-only unit tests for deployment refusal and update rollback boundaries."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock,patch

SOURCE=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('git_deploy',SOURCE/'deploy.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='planner-deploy-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.app=module.GitDeployment(SOURCE,self.root)

    def test_existing_state_is_not_overwritten_by_install(self):
        self.app.check_checkout=Mock()
        self.app.execute=Mock()
        self.app.state_path.write_text('{"phase":"complete"}',encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError,'already has deployment state'):self.app.install()
        self.app.execute.assert_not_called()
        self.assertEqual(self.app.state_path.read_text(),'{"phase":"complete"}')

    def test_literal_password_characters_survive_settings_read(self):
        value="literal$# 'quoted\" value"
        module.legacy.private_write(self.root/'.app.env',module.legacy.raw_env({'SMTP_PASS':value}))
        self.assertEqual(module.read_env(self.root/'.app.env')['SMTP_PASS'],value)

    def test_schema_changes_refuse_app_update(self):
        self.app.old={'Id':'fixture'}
        self.app.docker=Mock(return_value=SimpleNamespace(stdout='{}'))
        with self.assertRaisesRegex(RuntimeError,'Database migrations changed'):self.app.check_schema()

    def test_failed_update_restores_previous_settings_and_state(self):
        state={'phase':'complete','project':self.app.target.project,'revision':'old','app_image':'old-image'}
        original='APP_IMAGE=old-image\nAPP_PORT=3005\n'
        module.legacy.private_write(self.root/'.env.postgres',original)
        self.app.settings={'APP_IMAGE':'old-image','APP_PORT':'3005'}
        self.app.check_checkout=Mock()
        self.app.installed=Mock(return_value=state)
        self.app.check_schema=Mock()
        self.app.build_application=Mock(side_effect=lambda:setattr(self.app,'app_image','new-image'))
        self.app.backup_database=Mock(return_value=self.root/'backup')
        self.app.replace_app=Mock(side_effect=[RuntimeError('fixture startup failure'),None])
        self.app.verify_unrelated=Mock(return_value=[])
        with self.assertRaisesRegex(RuntimeError,'fixture startup failure'):self.app.update()
        self.assertEqual(self.app.replace_app.call_count,2)
        self.assertEqual((self.root/'.env.postgres').read_text(),original)
        self.assertEqual(self.app.settings['APP_IMAGE'],'old-image')
        self.assertEqual(json.loads(self.app.state_path.read_text()),state)

    def test_backup_failure_does_not_replace_app(self):
        self.app.check_checkout=Mock()
        self.app.installed=Mock(return_value={})
        self.app.check_schema=Mock()
        self.app.build_application=Mock()
        self.app.backup_database=Mock(side_effect=RuntimeError('backup failed'))
        self.app.replace_app=Mock()
        with self.assertRaisesRegex(RuntimeError,'backup failed'):self.app.update()
        self.app.replace_app.assert_not_called()
        self.assertFalse(self.app.state_path.exists())

    def test_image_preparation_failure_cannot_stop_legacy_container(self):
        self.app.preflight=Mock()
        self.app.prepare_backup=Mock()
        self.app.stop_and_snapshot=Mock()
        with self.assertRaisesRegex(RuntimeError,'image build failed'):
            self.app.execute(verify_archive=False,prepare_images=Mock(side_effect=RuntimeError('image build failed')))
        self.app.prepare_backup.assert_not_called()
        self.app.stop_and_snapshot.assert_not_called()

    @unittest.skipUnless(os.name=='posix','Linux file permissions')
    def test_container_config_is_readable_and_secrets_are_private(self):
        self.app.check_checkout=Mock()
        self.app.execute=Mock()
        self.app.install()
        self.assertEqual((self.root/'docker/pgadmin-servers.json').stat().st_mode & 0o044,0o044)
        self.assertEqual((self.root/'docker/init-app-user.sh').stat().st_mode & 0o055,0o055)
        module.legacy.private_write(self.root/'.app.env','SMTP_PASS=fixture\n')
        self.assertEqual((self.root/'.app.env').stat().st_mode & 0o777,0o600)

    @unittest.skipUnless(os.name=='posix','Linux deployment lock')
    def test_concurrent_deployment_is_refused_and_lock_releases(self):
        with module.deployment_lock(self.root):
            with self.assertRaisesRegex(RuntimeError,'already running'):
                with module.deployment_lock(self.root):self.fail('Second deployment obtained the lock')
        with module.deployment_lock(self.root):pass

    def test_dirty_git_checkout_is_refused(self):
        def git_result(args,**kwargs):
            return SimpleNamespace(stdout=' M server.js' if args[1]=='status' else 'a'*40)
        with patch.object(module.subprocess,'run',side_effect=git_result):
            with self.assertRaisesRegex(RuntimeError,'checkout has local changes'):self.app.check_checkout()

if __name__=='__main__':unittest.main()

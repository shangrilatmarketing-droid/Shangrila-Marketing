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

    def test_image_check_uses_server_compatible_direct_node_execution(self):
        self.app.app_image='fixture-image'
        self.app.docker=Mock(return_value=SimpleNamespace(stdout='runtime-ok'))
        self.app.check_image_execution()
        args=self.app.docker.call_args.args
        self.assertIn('/usr/local/bin/node',args)
        self.assertIn('node',args)
        self.assertNotIn('--cap-drop',args)
        self.assertNotIn('--security-opt',args)

    def test_compose_refresh_is_validated_before_it_becomes_active(self):
        old=self.root/'compose.yaml';old.write_text('old',encoding='utf-8')
        module.legacy.private_write(self.root/'.env.postgres','APP_IMAGE=fixture\n')
        with patch.object(module.subprocess,'run',return_value=SimpleNamespace(stdout='')) as run:
            self.app.stage_compose()
        self.assertEqual(old.read_bytes(),(SOURCE/'deploy/linux/compose.yaml').read_bytes())
        self.assertFalse((self.root/'compose.next.yaml').exists())
        self.assertIn(str(self.root/'compose.next.yaml'),run.call_args.args[0])
        self.assertEqual(run.call_args.args[0][-2:],['config','--quiet'])

    def test_merge_uses_server_compatible_unprivileged_node_execution(self):
        self.app.app_image='fixture-image';self.app.runtime={}
        self.app.old={'NetworkSettings':{'Networks':{'fixture-network':{}}}}
        self.app.inspect=Mock(return_value={'Labels':{'com.docker.compose.project':self.app.target.project}})
        self.app.docker=Mock(return_value=SimpleNamespace(stdout='Merge preview: {"final":{"users":1}}\n'))
        self.app.run_merge(self.root/'snapshot')
        args=self.app.docker.call_args.args
        self.assertIn('/usr/local/bin/node',args)
        self.assertEqual(args[args.index('--user')+1],'node')
        self.assertNotIn('--cap-drop',args)
        self.assertNotIn('--security-opt',args)

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
        self.app.stage_compose=Mock()
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
        self.app.stage_compose=Mock()
        self.app.replace_app=Mock()
        with self.assertRaisesRegex(RuntimeError,'backup failed'):self.app.update()
        self.app.stage_compose.assert_not_called()
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

    def test_recovery_refuses_nonempty_database(self):
        results=iter([
            SimpleNamespace(stdout='[{"schemaname":"public","tablename":"users"}]\n'),
            SimpleNamespace(stdout='1\n')
        ])
        self.app.docker=Mock(side_effect=lambda *args,**kwargs:next(results))
        with self.assertRaisesRegex(RuntimeError,'already contains data'):
            self.app.require_empty_database('fixture-db')

    def test_recovery_reuses_settings_and_takes_fresh_snapshot(self):
        state={'phase':'failed','project':self.app.target.project,'old_container':self.app.target.old}
        module.legacy.private_write(self.app.state_path,json.dumps(state))
        module.legacy.private_write(self.root/'.env.postgres',module.legacy.raw_env({
            'APP_PORT':'3005','PGADMIN_PORT':'5052','PGADMIN_EMAIL':'admin@example.com',
            'PGADMIN_PASSWORD':'pgadmin-password','APP_DB_PASSWORD':'database-password',
            'POSTGRES_ADMIN_PASSWORD':'administrator-password','APP_IMAGE':'old-image','MIGRATION_DIR':'old-snapshot'}))
        module.legacy.private_write(self.root/'.app.env',module.legacy.raw_env({
            'PORT':'3005','PGPASSWORD':'database-password','JWT_SECRET':'a'*64,'DISABLE_SCHEDULER':'false'}))
        old={'Id':'old-id','State':{'Running':True}}
        self.app.check_checkout=Mock()
        self.app.preflight=Mock(side_effect=lambda recovery=False:setattr(self.app,'old',old))
        self.app.compose=Mock(side_effect=lambda *args,**kwargs:SimpleNamespace(stdout={
            ('ps','--all','-q','db'):'db-id',('ps','--all','-q','pgadmin'):'pgadmin-id',
            ('ps','--all','-q','app'):''}.get(args,'')))
        def inspect(identifier,optional=False):
            if identifier in ['db-id','pgadmin-id']:
                service='db' if identifier=='db-id' else 'pgadmin'
                return {'State':{'Running':True},'Config':{'Labels':{
                    'com.docker.compose.project':self.app.target.project,
                    'com.docker.compose.service':service,
                    'com.docker.compose.project.working_dir':self.root.as_posix()}}}
            return None
        self.app.inspect=Mock(side_effect=inspect)
        self.app.require_empty_database=Mock()
        self.app.build_application=Mock(side_effect=lambda:setattr(self.app,'app_image','new-image'))
        backup=self.root/'backups/fresh';backup.mkdir(parents=True)
        self.app.prepare_backup=Mock(return_value={'DISABLE_SCHEDULER':'false','SMTP_PASS':'literal$#password'})
        self.app.backup=backup
        self.app.stop_and_snapshot=Mock(return_value={'users':7,'plans':11,'uploads':3})
        self.app.remove_old=Mock()
        self.app.import_data=Mock()
        self.app.start_app=Mock()
        self.app.verify_unrelated=Mock(return_value=[])
        self.app.recover()
        self.app.preflight.assert_called_once_with(recovery=True)
        self.app.require_empty_database.assert_called_once_with('db-id')
        self.app.stop_and_snapshot.assert_called_once()
        self.app.import_data.assert_called_once_with({'users':7,'plans':11,'uploads':3})
        result=json.loads(self.app.state_path.read_text())
        self.assertEqual(result['phase'],'complete')
        self.assertEqual(result['counts'],{'users':7,'plans':11,'uploads':3})
        settings=module.read_env(self.root/'.env.postgres')
        self.assertEqual(settings['APP_IMAGE'],'new-image')
        self.assertEqual(module.read_env(self.root/'.app.env')['SMTP_PASS'],'literal$#password')

    def test_verified_snapshot_rejects_any_changed_file(self):
        folder=self.root/'backups/legacy-fixture';snapshot=folder/'snapshot';snapshot.mkdir(parents=True)
        source=snapshot/'users.json';source.write_text('[]',encoding='utf-8')
        module.legacy.private_write(folder/'snapshot-sha256.json',json.dumps({'users.json':module.legacy.file_hash(source)}))
        self.assertEqual(self.app.verified_snapshot(folder),snapshot)
        source.write_text('[{}]',encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError,'checksum manifest'):self.app.verified_snapshot(folder)

    def test_legacy_restore_backs_up_before_transactional_merge(self):
        state={'phase':'complete','project':self.app.target.project,'revision':'old','app_image':'old-image'}
        module.legacy.private_write(self.app.state_path,json.dumps(state))
        module.legacy.private_write(self.root/'.env.postgres','APP_IMAGE=old-image\nAPP_PORT=3005\n')
        self.app.settings={'APP_IMAGE':'old-image','APP_PORT':'3005'};self.app.runtime={}
        events=[];preview={'final':{'users':9,'plans':1,'uploads':3}}
        self.app.check_checkout=Mock();self.app.installed=Mock(return_value=state);self.app.check_schema=Mock()
        self.app.verified_snapshot=Mock(return_value=self.root/'snapshot')
        self.app.build_application=Mock(side_effect=lambda:(events.append('build'),setattr(self.app,'app_image','new-image')))
        self.app.run_merge=Mock(side_effect=lambda snapshot,apply=False:(events.append('merge' if apply else 'preview') or preview))
        self.app.backup_database=Mock(side_effect=lambda save_image=False:(events.append('backup') or self.root/'postgres-backup'))
        self.app.stage_compose=Mock(side_effect=lambda:events.append('compose'))
        self.app.verify_merge_counts=Mock(side_effect=lambda summary:events.append('verify'))
        self.app.replace_app=Mock(side_effect=lambda:events.append('replace'))
        self.app.verify_unrelated=Mock(return_value=[])
        self.app.restore_legacy('fixture')
        self.assertEqual(events,['build','preview','backup','compose','merge','verify','replace'])
        self.assertEqual(json.loads(self.app.state_path.read_text())['legacy_restore'],preview)
        self.assertEqual(module.read_env(self.root/'.env.postgres')['APP_IMAGE'],'new-image')

if __name__=='__main__':unittest.main()

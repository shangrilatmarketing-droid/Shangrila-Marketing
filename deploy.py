#!/usr/bin/env python3
"""Install from Git or update only the planner application. Run on the Linux server."""
import argparse
from contextlib import contextmanager
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import subprocess
import sys

SOURCE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('planner_legacy_deploy',SOURCE/'deploy/linux/deploy-linux.py')
legacy=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=legacy
spec.loader.exec_module(legacy)

def read_env(path):
    values={}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#'): continue
        key,separator,value=line.partition('=')
        if not separator: raise RuntimeError('Invalid environment file: '+Path(path).name)
        values[key]=value
    return values

@contextmanager
def deployment_lock(root):
    import fcntl
    fd=os.open(root/'.deployment.lock',os.O_CREAT|os.O_RDWR,0o600)
    try:
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('Another planner deployment or backup is already running.')
        yield
    finally: os.close(fd)

class GitDeployment(legacy.Deployment):
    def __init__(self,source=SOURCE,runtime_root=None,target=None):
        self.source=Path(source).resolve()
        root=Path(runtime_root or self.source/'deploy/runtime').resolve()
        root.mkdir(parents=True,exist_ok=True,mode=0o700)
        super().__init__(root,target)
        self.revision=''

    def record(self,phase,**extra):
        super().record(phase,revision=self.revision,app_image=self.app_image,**extra)

    def check_checkout(self):
        def git(*args):
            return subprocess.run(['git',*args],cwd=self.source,capture_output=True,text=True,check=True).stdout.strip()
        self.revision=git('rev-parse','HEAD')
        if git('status','--porcelain','--untracked-files=normal'):
            raise RuntimeError('The checkout has local changes. Commit or preserve them before deploying; this command does not overwrite them.')
        if shutil.disk_usage(self.root).free<2*1024**3:
            raise RuntimeError('At least 2 GiB of free disk space is required before preparing images and backups.')

    def compose_arguments(self,*args):
        return ['docker','compose','--env-file',str(self.root/'.env.postgres'),'-p',self.target.project,'-f',str(self.root/'compose.yaml'),*args]

    def build_application(self):
        self.app_image='plan-reminder:git-'+self.revision[:12]+'-'+secrets.token_hex(4)
        print('Building the application image from this Git checkout. The current app stays running.',flush=True)
        self.docker('build','--platform','linux/amd64','--tag',self.app_image,self.source)
        self.check_image_execution()

    def check_image_execution(self):
        for user,extra in [('node',[]),('root',['--cap-add','DAC_OVERRIDE'])]:
            self.docker('run','--rm','--network','none','--read-only','--user',user,'--cap-drop','ALL',*extra,'--security-opt','no-new-privileges:true','--entrypoint','/usr/local/bin/node',self.app_image,'-e','process.stdout.write("runtime-ok")')
        print('Verified application and migration executable permissions before stopping the old app.',flush=True)

    def require_empty_database(self,identifier):
        def sql(query):
            return self.docker('exec',identifier,'psql','-U','postgres','-d','plan_reminder','-tA','-v','ON_ERROR_STOP=1','-c',query).stdout.strip()
        tables=json.loads(sql("SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' AND schemaname <> 'information_schema') t"))
        allowed={'schema_migrations','users','plans','company_budgets','plan_uploads','email_digest_deliveries','data_imports'}
        for table in tables:
            name=table['tablename']
            if table['schemaname']!='public' or name not in allowed:
                raise RuntimeError('Unexpected tables in the destination. Recovery will not overwrite this database.')
            if name!='schema_migrations' and int(sql('SELECT count(*) FROM public."'+name+'"')):
                raise RuntimeError('The destination already contains data. Recovery will not overwrite it.')

    def recover(self):
        self.check_checkout()
        state=json.loads(self.state_path.read_text(encoding='utf-8'))
        if state.get('phase')!='failed' or state.get('project')!=self.target.project or state.get('old_container')!=self.target.old:
            raise RuntimeError('Recovery is only for this planner\'s failed initial installation.')
        self.settings=read_env(self.root/'.env.postgres')
        self.runtime=read_env(self.root/'.app.env')
        if self.settings.get('APP_PORT')!=str(self.target.app_port) or self.settings.get('PGADMIN_PORT')!=str(self.target.pgadmin_port):
            raise RuntimeError('Unexpected recovery ports; no containers were stopped.')
        self.preflight(recovery=True)
        if not self.old['State']['Running']: raise RuntimeError('The restored old planner must be running before recovery.')
        for service in ['db','pgadmin','app']:
            identifier=self.compose('ps','--all','-q',service).stdout.strip()
            if not identifier and service=='app': continue
            if not identifier or len(identifier.splitlines())!=1: raise RuntimeError('Expected one recovery container for '+service)
            info=self.inspect(identifier); labels=info['Config'].get('Labels') or {}
            if labels.get('com.docker.compose.project')!=self.target.project or labels.get('com.docker.compose.service')!=service or labels.get('com.docker.compose.project.working_dir','').replace('\\','/')!=self.root.as_posix():
                raise RuntimeError('Recovery container ownership does not match this checkout.')
            if service=='app' and info['State']['Running']: raise RuntimeError('A new app is already running; recovery will not replace it.')
            if service in ['db','pgadmin'] and not info['State']['Running']: raise RuntimeError(service+' must be running before this recovery.')
            if service=='db': self.require_empty_database(identifier)
        print('Destination is empty. Existing database credentials, volumes and earlier backups will be retained.',flush=True)
        self.build_application()
        self.new_started=True
        try:
            original=self.prepare_backup()
            legacy.private_write(self.backup/'previous-deployment-state.json',json.dumps(state,indent=2)+'\n')
            self.settings.update(APP_IMAGE=self.app_image,MIGRATION_DIR='./'+self.backup.relative_to(self.root).as_posix()+'/snapshot')
            self.resume_scheduler=original.get('DISABLE_SCHEDULER','false')
            self.runtime['DISABLE_SCHEDULER']='true'
            for key in ['SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM','PUBLIC_URL','TRUST_PROXY','COOKIE_SECURE']:
                if key in original:self.runtime[key]=original[key]
            legacy.private_write(self.root/'.env.postgres',legacy.raw_env(self.settings))
            legacy.private_write(self.root/'.app.env',legacy.raw_env(self.runtime))
            shutil.copyfile(self.source/'deploy/linux/compose.yaml',self.root/'compose.yaml')
            self.compose('config','--quiet')
            counts=self.stop_and_snapshot()
            self.remove_old()
            self.import_data(counts)
            self.start_app()
            changed=self.verify_unrelated()
            legacy.private_write(self.root/'ACCESS.txt','Planner port: '+str(self.target.app_port)+'\npgAdmin email: '+self.settings['PGADMIN_EMAIL']+'\npgAdmin password: '+self.settings['PGADMIN_PASSWORD']+'\nDatabase connection password (APP_DB_PASSWORD): '+self.settings['APP_DB_PASSWORD']+'\n')
            self.record('complete',counts=counts,other_containers_changed=changed)
            print('DONE. Recovery completed using a fresh snapshot of the server\'s current data.',flush=True)
        except BaseException as error:
            try:self.rollback()
            except Exception as restore_error:print('Automatic rollback needs attention: '+str(restore_error),file=sys.stderr)
            self.record('failed',error=str(error))
            self.verify_unrelated()
            raise

    def verified_snapshot(self,value):
        if not value: raise RuntimeError('Specify the verified backup folder with --snapshot.')
        folder=Path(value).expanduser().resolve()
        backup_root=(self.root/'backups').resolve()
        if backup_root not in folder.parents or not folder.name.startswith('legacy-'):
            raise RuntimeError('The snapshot must be a legacy backup inside deploy/runtime/backups.')
        snapshot=folder/'snapshot'; manifest_file=folder/'snapshot-sha256.json'
        if not snapshot.is_dir() or not manifest_file.is_file(): raise RuntimeError('The backup has no snapshot or checksum manifest.')
        manifest=json.loads(manifest_file.read_text(encoding='utf-8'))
        actual={str(path.relative_to(snapshot)).replace('\\','/'):legacy.file_hash(path) for path in snapshot.rglob('*') if path.is_file()}
        if actual!=manifest: raise RuntimeError('The legacy snapshot files do not match their verified checksum manifest.')
        return snapshot

    def merge_network(self):
        networks=self.old.get('NetworkSettings',{}).get('Networks') or {}
        if len(networks)!=1: raise RuntimeError('Expected one application network before restore.')
        name=next(iter(networks))
        info=self.inspect(name)
        labels=info.get('Labels') or {}
        if labels.get('com.docker.compose.project')!=self.target.project:
            raise RuntimeError('The application network does not belong to this deployment.')
        return name

    def run_merge(self,snapshot,apply=False):
        args=['run','--rm','--network',self.merge_network(),'--env-file',self.root/'.app.env',
            '--user','root','--read-only','--cap-drop','ALL','--cap-add','DAC_OVERRIDE',
            '--security-opt','no-new-privileges:true','--mount','type=bind,source='+str(snapshot)+',target=/migration,readonly',
            '--entrypoint','/usr/local/bin/node',self.app_image,'scripts/merge-json.js','/migration']
        if apply: args.append('--apply')
        result=self.docker(*args)
        prefix='Merged legacy snapshot: ' if apply else 'Merge preview: '
        line=next((line for line in result.stdout.splitlines() if line.startswith(prefix)),None)
        if not line: raise RuntimeError('The legacy merge did not report a verified summary.')
        return json.loads(line[len(prefix):])

    def verify_merge_counts(self,expected):
        identifier=self.compose('ps','-q','db').stdout.strip()
        query='SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM plans),(SELECT count(*) FROM plan_uploads),(SELECT count(*) FROM data_imports)'
        result=self.docker('exec',identifier,'psql','-U','postgres','-d','plan_reminder','-tA','-v','ON_ERROR_STOP=1','-c',query).stdout.strip()
        values=list(map(int,result.split('|')))
        wanted=expected['final']
        if values!=[wanted['users'],wanted['plans'],wanted['uploads'],1]:
            raise RuntimeError('Post-restore database counts do not match the transactional merge summary.')

    def restore_legacy(self,snapshot_value):
        self.check_checkout()
        state=self.installed()
        self.check_schema()
        snapshot=self.verified_snapshot(snapshot_value)
        self.build_application()
        preview=self.run_merge(snapshot,False)
        print('Verified merge preview: '+json.dumps(preview,separators=(',',':')),flush=True)
        backup=self.backup_database(save_image=True)
        old_settings=(self.root/'.env.postgres').read_text(encoding='utf-8')
        previous=dict(state); merged=False
        try:
            legacy.private_write(self.state_path,json.dumps({**state,'phase':'restoring-legacy','restore_backup':str(backup)},indent=2)+'\n')
            summary=self.run_merge(snapshot,True);merged=True
            self.verify_merge_counts(summary)
            self.settings['APP_IMAGE']=self.app_image
            legacy.private_write(self.root/'.env.postgres',legacy.raw_env(self.settings))
            self.replace_app()
            changed=self.verify_unrelated()
            state.update(phase='complete',revision=self.revision,app_image=self.app_image,
                restored_legacy_snapshot=str(snapshot.parent),legacy_restore=summary,
                restore_backup=str(backup),other_containers_changed=changed)
            legacy.private_write(self.state_path,json.dumps(state,indent=2)+'\n')
            print('DONE. Missing legacy accounts, plans and images were restored; current rows were retained.',flush=True)
        except BaseException:
            if merged:
                print('Legacy data was merged transactionally, but application replacement failed. Restoring the previous app image.',flush=True)
                legacy.private_write(self.root/'.env.postgres',old_settings);self.settings=read_env(self.root/'.env.postgres')
                try:self.replace_app()
                except Exception:print('Automatic app rollback needs attention. The database backup and merged data were retained.',file=sys.stderr,flush=True)
                previous.update(phase='complete',legacy_restore=summary,restore_backup=str(backup))
                legacy.private_write(self.state_path,json.dumps(previous,indent=2)+'\n')
            else:
                legacy.private_write(self.state_path,json.dumps(previous,indent=2)+'\n')
            self.verify_unrelated()
            raise

    def prepare_images(self):
        self.build_application()
        for upstream,local in [('postgres:18.6-alpine','plan-reminder-db:18.6'),('dpage/pgadmin4:9.17','plan-reminder-pgadmin:9.17')]:
            print('Preparing '+upstream+' for this planner.',flush=True)
            self.docker('pull',upstream)
            self.docker('image','tag',upstream,local)

    def install(self):
        self.check_checkout()
        if self.state_path.exists() or (self.root/'.env.postgres').exists() or (self.root/'.app.env').exists():
            raise RuntimeError('This checkout already has deployment state. Use update for a completed installation, or status to review a failed installation.')
        for name in ['compose.yaml','docker/init-app-user.sh','docker/pgadmin-servers.json']:
            target=self.root/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(self.source/'deploy/linux'/name,target)
            # Bind-mounted configuration must be readable by the container's UID.
            # Credentials are separate 0600 files, never stored in these mounts.
            if os.name!='nt': target.chmod(0o755 if name.endswith('.sh') else 0o644 if name.startswith('docker/') else 0o600)
        self.execute(verify_archive=False,prepare_images=self.prepare_images)

    def installed(self):
        if not self.state_path.exists(): raise RuntimeError('No installation found in this checkout. Run python3 deploy.py install first.')
        state=json.loads(self.state_path.read_text(encoding='utf-8'))
        if state.get('phase')!='complete' or state.get('project')!=self.target.project:
            raise RuntimeError('The previous deployment is not complete. Run status and review its error before making changes.')
        self.settings=read_env(self.root/'.env.postgres')
        self.runtime=read_env(self.root/'.app.env')
        if self.settings.get('APP_PORT')!=str(self.target.app_port): raise RuntimeError('Unexpected application port in deployment settings.')
        for service in ['app','db','pgadmin']:
            identifier=self.compose('ps','--all','-q',service).stdout.strip()
            if not identifier or len(identifier.splitlines())!=1: raise RuntimeError('Expected exactly one '+service+' container in this deployment.')
            info=self.inspect(identifier)
            labels=info['Config'].get('Labels') or {}
            directory=labels.get('com.docker.compose.project.working_dir','').replace('\\','/')
            if labels.get('com.docker.compose.project')!=self.target.project or labels.get('com.docker.compose.service')!=service or directory!=self.root.as_posix():
                raise RuntimeError('Container ownership does not match this checkout: '+service)
            if not info['State']['Running']: raise RuntimeError(service+' is stopped; review its status before updating.')
            if service=='app': self.old=info
        self.unrelated=self.snapshot_unrelated()
        self.wait_http(self.target.app_port,'/health',postgres=True)
        return state

    def check_schema(self):
        code="const fs=require('fs'),c=require('crypto');process.stdout.write(JSON.stringify(Object.fromEntries(fs.readdirSync('/app/migrations').filter(n=>n.endsWith('.sql')).sort().map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/migrations/'+n)).digest('hex')]))))"
        current=json.loads(self.docker('exec',self.old['Id'],'node','-e',code).stdout)
        proposed={p.name:legacy.file_hash(p) for p in sorted((self.source/'migrations').glob('*.sql'))}
        if current!=proposed:
            raise RuntimeError('Database migrations changed. A reviewed database upgrade is required; the app-only update has not changed any services.')

    def backup_database(self,save_image=False):
        stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3)
        backup=self.root/'backups'/('postgres-'+stamp);backup.mkdir(parents=True,mode=0o700)
        for name in ['.env.postgres','.app.env','compose.yaml','deployment-state.json']:
            legacy.private_write(backup/name,(self.root/name).read_text(encoding='utf-8'))
        dump=backup/'planner.dump'
        fd=os.open(dump,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
        with os.fdopen(fd,'wb') as stream:
            result=subprocess.run(self.compose_arguments('exec','-T','db','pg_dump','-U','postgres','-d','plan_reminder','-Fc'),cwd=self.root,stdout=stream,stderr=subprocess.PIPE)
        if result.returncode or not dump.stat().st_size: raise RuntimeError('PostgreSQL backup failed; no application replacement was attempted.')
        with dump.open('rb') as stream:
            result=subprocess.run(self.compose_arguments('exec','-T','db','pg_restore','--list'),cwd=self.root,stdin=stream,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        if result.returncode: raise RuntimeError('PostgreSQL backup verification failed; no application replacement was attempted.')
        legacy.private_write(backup/'SHA256SUMS',legacy.file_hash(dump)+'  planner.dump\n')
        if save_image: self.docker('image','save','--output',backup/'previous-app-image.tar',self.old['Image'])
        print('Verified database backup: '+str(dump),flush=True)
        return backup

    def replace_app(self):
        self.compose('up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120','app')
        self.wait_http(self.target.app_port,'/health',postgres=True)
        info=self.inspect(self.compose('ps','-q','app').stdout.strip())
        expected=self.docker('image','inspect','--format','{{.Id}}',self.settings['APP_IMAGE']).stdout.strip()
        if info['Image']!=expected: raise RuntimeError('The replacement application is using an unexpected image.')
        environment=dict(item.split('=',1) for item in info['Config']['Env'])
        if any(environment.get(k)!=v for k,v in self.runtime.items()): raise RuntimeError('Application settings changed unexpectedly during replacement.')

    def update(self):
        self.check_checkout()
        state=self.installed()
        self.check_schema()
        self.build_application()
        backup=self.backup_database(save_image=True)
        old_settings=(self.root/'.env.postgres').read_text(encoding='utf-8')
        previous=dict(state)
        try:
            legacy.private_write(self.state_path,json.dumps({**state,'phase':'updating','last_update_backup':str(backup)},indent=2)+'\n')
            self.settings['APP_IMAGE']=self.app_image
            legacy.private_write(self.root/'.env.postgres',legacy.raw_env(self.settings))
            self.replace_app()
            changed=self.verify_unrelated()
            state.update(phase='complete',revision=self.revision,app_image=self.app_image,last_update_backup=str(backup),other_containers_changed=changed)
            legacy.private_write(self.state_path,json.dumps(state,indent=2)+'\n')
            print('DONE. Application updated; database and pgAdmin containers were retained.',flush=True)
        except BaseException:
            print('Update failed. Restoring the previous app image and settings.',flush=True)
            legacy.private_write(self.root/'.env.postgres',old_settings)
            self.settings=read_env(self.root/'.env.postgres')
            try:
                self.replace_app()
                legacy.private_write(self.state_path,json.dumps(previous,indent=2)+'\n')
                print('Previous application restored. PostgreSQL data was not reverted.',flush=True)
            except Exception:
                legacy.private_write(self.state_path,json.dumps({**previous,'phase':'update-rollback-failed','last_update_backup':str(backup)},indent=2)+'\n')
                print('Automatic app rollback needs attention. Keep the backup and this checkout.',file=sys.stderr,flush=True)
            self.verify_unrelated()
            raise

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['install','update','recover','restore-legacy','status','backup'],nargs='?',default='install')
    parser.add_argument('--snapshot',help='Legacy backup folder under deploy/runtime/backups (restore-legacy only).')
    args=parser.parse_args()
    if args.action=='status':
        state=SOURCE/'deploy/runtime/deployment-state.json'
        print(state.read_text(encoding='utf-8') if state.exists() else 'Not deployed from this checkout.');return
    if platform.system()!='Linux' or platform.machine().lower() not in ['x86_64','amd64']:
        raise RuntimeError('Run this command in the Linux server terminal. This deployment targets Linux x86_64.')
    for command in ['docker','git']:
        if not shutil.which(command): raise RuntimeError(command+' is required on the server.')
    os.umask(0o077)
    deployment=GitDeployment()
    with deployment_lock(deployment.root):
        if args.action=='install': deployment.install()
        elif args.action=='update': deployment.update()
        elif args.action=='recover': deployment.recover()
        elif args.action=='restore-legacy': deployment.restore_legacy(args.snapshot)
        else:
            deployment.installed()
            deployment.backup_database()

if __name__=='__main__':
    try: main()
    except (Exception,KeyboardInterrupt) as error:
        print('STOPPED: '+str(error)+'\nKeep the checkout and backups. Share the error text, not environment files or ACCESS.txt.',file=sys.stderr)
        sys.exit(1)

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
    parser.add_argument('action',choices=['install','update','status','backup'],nargs='?',default='install')
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
        else:
            deployment.installed()
            deployment.backup_database()

if __name__=='__main__':
    try: main()
    except (Exception,KeyboardInterrupt) as error:
        print('STOPPED: '+str(error)+'\nKeep the checkout and backups. Share the error text, not environment files or ACCESS.txt.',file=sys.stderr)
        sys.exit(1)

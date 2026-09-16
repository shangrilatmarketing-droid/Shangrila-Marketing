#!/usr/bin/env python3
"""Deploy only the known planner container. No daemon restart, prune or volume deletion."""
import argparse
from dataclasses import dataclass
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request

APP_IMAGE='plan-reminder:2026-09-15-postgres'
IMAGE_NAMES=[APP_IMAGE,'plan-reminder-db:18.6','plan-reminder-pgadmin:9.17']

@dataclass
class Target:
    old: str='shangrila-marketing-tracker-v2'
    expected_directory: str='/home/shangrila002/marketing-planner'
    expected_service: str='shangrila-app'
    project: str='plan-reminder-postgres'
    app_port: int=3005
    pgadmin_port: int=5052

def private_write(path, text):
    path=Path(path)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w',encoding='utf-8',newline='\n') as stream: stream.write(text)
    if os.name!='nt': path.chmod(0o600)

def file_hash(path):
    digest=hashlib.sha256()
    with open(path,'rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
    return digest.hexdigest()

def raw_env(values):
    lines=[]
    for key,value in values.items():
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*',key): raise RuntimeError('Invalid environment key.')
        value=str(value)
        if '\n' in value or '\r' in value or '\x00' in value: raise RuntimeError('Multiline legacy settings need manual review before deployment.')
        lines.append(key+'='+value)
    return '\n'.join(lines)+'\n'

def restore_arguments(info,env_path):
    """Recreate the saved single legacy container using argv, never shell text."""
    config=info['Config']; host=info['HostConfig']
    args=['create','--name',info['Name'].lstrip('/'),'--env-file',str(env_path)]
    policy=host.get('RestartPolicy',{}); restart=policy.get('Name') or 'no'
    if restart=='on-failure' and policy.get('MaximumRetryCount'): restart+=':'+str(policy['MaximumRetryCount'])
    args+=['--restart',restart]
    for key,option in [('User','--user'),('WorkingDir','--workdir'),('Hostname','--hostname')]:
        if config.get(key): args += [option,config[key]]
    for key,option in [('ReadonlyRootfs','--read-only'),('Init','--init')]:
        if host.get(key): args.append(option)
    for key,option in [('Memory','--memory'),('MemorySwap','--memory-swap'),('NanoCpus','--cpus'),('PidsLimit','--pids-limit')]:
        if host.get(key): args += [option,str(host[key]/1e9 if key=='NanoCpus' else host[key])]
    for key,option in [('CapAdd','--cap-add'),('CapDrop','--cap-drop'),('SecurityOpt','--security-opt'),('Dns','--dns'),('ExtraHosts','--add-host')]:
        for value in host.get(key) or []: args += [option,value]
    log=host.get('LogConfig') or {}
    if log.get('Type'): args += ['--log-driver',log['Type']]
    for key,value in (log.get('Config') or {}).items(): args += ['--log-opt',key+'='+value]
    for key,value in (config.get('Labels') or {}).items(): args += ['--label',key+'='+value]
    for mount in info['Mounts']:
        if mount['Type']!='bind': raise RuntimeError('Rollback supports the verified bind-mounted legacy app only.')
        if ',' in mount['Source'] or ',' in mount['Destination']: raise RuntimeError('Unusual mount path requires manual rollback.')
        item='type=bind,source='+mount['Source']+',target='+mount['Destination']
        if not mount.get('RW',True): item+=',readonly'
        if mount.get('Propagation'): item+=',bind-propagation='+mount['Propagation']
        args += ['--mount',item]
    for port,bindings in (host.get('PortBindings') or {}).items():
        for binding in bindings or []:
            ip=binding.get('HostIp') or ''
            if ':' in ip: ip='['+ip+']'
            args += ['--publish',(ip+':' if ip else '')+binding['HostPort']+':'+port]
    networks=info.get('NetworkSettings',{}).get('Networks') or {}
    if len(networks)!=1: raise RuntimeError('Unexpected legacy networks; review before removing this container.')
    network,details=next(iter(networks.items())); args += ['--network',network]
    if network!='bridge':
        for alias in details.get('Aliases') or []:
            if not re.fullmatch(r'[a-f0-9]{12,64}',alias): args += ['--network-alias',alias]
    entry=config.get('Entrypoint') or []
    args += ['--entrypoint',entry[0] if entry else '',info['Image']]
    args += entry[1:]+(config.get('Cmd') or [])
    return args

class Deployment:
    def __init__(self,root,target=None):
        self.root=Path(root).resolve(); self.target=target or Target()
        self.state_path=self.root/'deployment-state.json'
        self.old=None; self.old_stopped=False; self.old_removed=False; self.new_started=False
        self.backup=None; self.settings={}; self.runtime={}; self.unrelated={}
        self.app_image=APP_IMAGE

    def docker(self,*args,check=True):
        environment=os.environ.copy()
        if args and args[0]=='compose': environment.update(self.settings)
        result=subprocess.run(['docker',*map(str,args)],cwd=self.root,env=environment,text=True,encoding='utf-8',errors='replace',capture_output=True)
        if check and result.returncode:
            # Do not echo command arguments or resolved Compose configuration (secrets).
            raise RuntimeError('Docker operation failed: '+str(args[0])+'. '+result.stderr.strip()[-1800:])
        return result

    def compose(self,*args,check=True):
        return self.docker('compose','--env-file',self.root/'.env.postgres','-p',self.target.project,'-f',self.root/'compose.yaml',*args,check=check)

    def inspect(self,identifier,optional=False):
        result=self.docker('inspect',identifier,check=not optional)
        return json.loads(result.stdout)[0] if result.returncode==0 else None

    def record(self,phase,**extra):
        data={'phase':phase,'old_container':self.target.old,'project':self.target.project,'backup':str(self.backup or ''),**extra}
        private_write(self.state_path,json.dumps(data,indent=2)+'\n')

    def verify_package(self):
        manifest=json.loads((self.root/'manifest.json').read_text(encoding='utf-8'))
        for relative,expected in manifest['files'].items():
            item=(self.root/relative).resolve()
            if self.root not in item.parents or not item.is_file() or item.is_symlink(): raise RuntimeError('Invalid package member: '+relative)
            if file_hash(item)!=expected: raise RuntimeError('Package checksum mismatch: '+relative)
        return manifest

    def snapshot_unrelated(self):
        ids=self.docker('ps','-q','--no-trunc').stdout.split()
        result={}
        for identifier in ids:
            if self.old and identifier==self.old['Id']: continue
            state=json.loads(self.docker('inspect','--format','{{json .State}}',identifier).stdout)
            result[identifier]={'started_at':state['StartedAt'],'running':state['Running']}
        return result

    def verify_unrelated(self):
        changed=[]
        for identifier,expected in self.unrelated.items():
            response=self.docker('inspect','--format','{{json .State}}',identifier,check=False)
            if response.returncode: changed.append(identifier[:12]); continue
            state=json.loads(response.stdout)
            if state['StartedAt']!=expected['started_at'] or state['Running']!=expected['running']: changed.append(identifier[:12])
        if changed: print('Other containers changed state during the run: '+', '.join(changed)+'. This installer did not issue stop/recreate commands for them.',flush=True)
        else: print('Verified: all '+str(len(self.unrelated))+' other running containers kept their IDs and start times.',flush=True)
        return changed

    def preflight(self,recovery=False):
        if not recovery and self.state_path.exists(): raise RuntimeError('This deployment directory already has a state file. Use --status; do not overwrite an earlier migration.')
        if not recovery and ((self.root/'.env.postgres').exists() or (self.root/'.app.env').exists()): raise RuntimeError('This directory already has settings. Use a fresh deployment directory or review it before continuing.')
        self.docker('version','--format','{{.Server.Version}}')
        compose_version=self.docker('compose','version','--short').stdout.strip().lstrip('v')
        match=re.match(r'(\d+)\.(\d+)',compose_version)
        if not match or tuple(map(int,match.groups()))<(2,30): raise RuntimeError('Docker Compose 2.30 or later is required for literal environment-file values.')
        self.old=self.inspect(self.target.old)
        labels=self.old['Config'].get('Labels') or {}
        if self.old['Name']!='/'+self.target.old or labels.get('com.docker.compose.project.working_dir')!=self.target.expected_directory or labels.get('com.docker.compose.service')!=self.target.expected_service:
            raise RuntimeError('The container identity differs from the verified planner. Nothing was stopped.')
        bindings=self.old['HostConfig'].get('PortBindings') or {}
        if not any(b['HostPort']==str(self.target.app_port) for b in bindings.get('3005/tcp') or []): raise RuntimeError('The expected planner is not publishing the required port. Nothing was stopped.')
        if self.old['HostConfig'].get('Privileged') or self.old['HostConfig'].get('Links') or self.old['HostConfig'].get('VolumesFrom'): raise RuntimeError('Unexpected legacy privileges or linked containers. Manual review required.')
        expected={self.target.expected_directory+'/'+name:'/app/'+name for name in ['users.json','database.json','budget.json','uploads']}
        actual={m['Source'].replace('\\','/'):m['Destination'] for m in self.old['Mounts'] if m['Type']=='bind'}
        for source,destination in expected.items():
            if actual.get(source.replace('\\','/'))!=destination: raise RuntimeError('Legacy data mounts do not match the inspected deployment.')
        restore_arguments(self.old,self.root/'unused.env') # Ensure rollback is representable before removal.
        if recovery:
            self.unrelated=self.snapshot_unrelated()
            return
        for kind in ['container','volume','network']:
            args=[kind,'ls','-q']+(['-a'] if kind=='container' else [])+['--filter','label=com.docker.compose.project='+self.target.project]
            if self.docker(*args).stdout.strip(): raise RuntimeError('The new project already has '+kind+' resources. Existing PostgreSQL data will not be overwritten.')
        with socket.socket() as probe:
            try: probe.bind(('0.0.0.0',self.target.pgadmin_port))
            except OSError: raise RuntimeError('pgAdmin port '+str(self.target.pgadmin_port)+' is already in use. Nothing was stopped.')
        self.unrelated=self.snapshot_unrelated()

    def prepare_backup(self):
        stamp=dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+secrets.token_hex(3)
        self.backup=self.root/'backups'/('legacy-'+stamp); self.backup.mkdir(parents=True,mode=0o700)
        if os.name!='nt': self.backup.parent.chmod(0o700)
        private_write(self.backup/'container.json',json.dumps(self.old,indent=2)+'\n')
        private_write(self.backup/'unrelated-before.json',json.dumps(self.unrelated,indent=2)+'\n')
        env={item.split('=',1)[0]:item.split('=',1)[1] for item in self.old['Config'].get('Env') or [] if '=' in item}
        private_write(self.backup/'legacy-runtime.env',raw_env(env))
        self.docker('image','save','--output',self.backup/'legacy-image.tar',self.old['Image'])
        # Capture dotenv values without printing them, then apply actual process-env precedence.
        dotenv={}
        copied=self.docker('cp',self.old['Id']+':/app/.env',self.backup/'legacy.env',check=False)
        if copied.returncode==0:
            if os.name!='nt': (self.backup/'legacy.env').chmod(0o600)
            code="process.stdout.write(JSON.stringify(require('dotenv').parse(require('fs').readFileSync('/snapshot/legacy.env'))))"
            parsed=self.docker('run','--rm','--read-only','--network','none','--user','0','--mount','type=bind,source='+str(self.backup)+',target=/snapshot,readonly','--entrypoint','node',self.app_image,'-e',code)
            dotenv=json.loads(parsed.stdout)
        combined={**dotenv,**env}
        private_write(self.backup/'legacy-runtime.env',raw_env(combined))
        return combined

    def prepare_settings(self,legacy):
        self.settings={'APP_PORT':str(self.target.app_port),'BIND_ADDRESS':'0.0.0.0','PGADMIN_PORT':str(self.target.pgadmin_port),'PGADMIN_EMAIL':'admin@example.com',
            'POSTGRES_ADMIN_PASSWORD':secrets.token_hex(48),'APP_DB_PASSWORD':secrets.token_hex(48),'PGADMIN_PASSWORD':secrets.token_hex(48),'MIGRATION_DIR':'./'+str(self.backup.relative_to(self.root)).replace('\\','/')+'/snapshot'}
        self.settings['APP_IMAGE']=self.app_image
        jwt=legacy.get('JWT_SECRET','')
        if len(jwt)<32 or jwt=='super_secret_shangrila_key_123': jwt=secrets.token_hex(48)
        selected=['SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','SMTP_FROM','PUBLIC_URL','TRUST_PROXY','COOKIE_SECURE']
        self.runtime={key:legacy[key] for key in selected if key in legacy}
        self.runtime.update({'NODE_ENV':'production','PORT':'3005','TZ':legacy.get('TZ') or 'Asia/Kathmandu','PGHOST':'db','PGPORT':'5432','PGDATABASE':'plan_reminder','PGUSER':'plan_reminder_app','PGPASSWORD':self.settings['APP_DB_PASSWORD'],'JWT_SECRET':jwt,'DISABLE_SCHEDULER':'true'})
        self.resume_scheduler=legacy.get('DISABLE_SCHEDULER','false')
        private_write(self.root/'.env.postgres',raw_env(self.settings))
        private_write(self.root/'.app.env',raw_env(self.runtime))
        rendered=json.loads(self.compose('config','--format','json').stdout)
        actual=rendered['services']['app']['environment']
        # Compose config may escape literal dollars for re-serialization. Also check
        # the actual container environment after startup, before enabling reminders.
        if any(actual.get(k) not in [v,v.replace('$','$$')] for k,v in self.runtime.items()): raise RuntimeError('A setting did not survive Compose parsing; source container has not been stopped.')

    def stop_and_snapshot(self):
        current=self.inspect(self.target.old)
        if current['Id']!=self.old['Id']: raise RuntimeError('The source container changed during preparation.')
        self.docker('stop','--time','30',self.old['Id']); self.old_stopped=True
        snapshot=self.backup/'snapshot'; snapshot.mkdir(mode=0o700)
        for name in ['users.json','database.json','budget.json','uploads']:
            self.docker('cp',self.old['Id']+':/app/'+name,snapshot/name)
        self.docker('cp',self.old['Id']+':/app/reminders.json',snapshot/'reminders.json',check=False)
        checked=self.docker('run','--rm','--read-only','--network','none','--user','node','--mount','type=bind,source='+str(snapshot)+',target=/migration,readonly','--entrypoint','/usr/local/bin/node',self.app_image,'scripts/import-json.js','/migration','--check')
        counts=json.loads(checked.stdout.strip().splitlines()[-1])
        manifest={str(p.relative_to(snapshot)).replace('\\','/'):file_hash(p) for p in snapshot.rglob('*') if p.is_file()}
        private_write(self.backup/'snapshot-sha256.json',json.dumps(manifest,indent=2)+'\n')
        with tarfile.open(self.backup/'legacy-data.tar.gz','w:gz') as archive: archive.add(snapshot,arcname='snapshot')
        with tarfile.open(self.backup/'legacy-data.tar.gz','r:gz') as archive:
            for name,expected in manifest.items():
                file=archive.extractfile('snapshot/'+name)
                if file is None or hashlib.sha256(file.read()).hexdigest()!=expected: raise RuntimeError('Snapshot archive verification failed.')
        self.record('backup-verified',counts=counts)
        print('Verified backup: '+str(counts['users'])+' accounts, '+str(counts['plans'])+' plans, '+str(counts['uploads'])+' images.',flush=True)
        return counts

    def remove_old(self):
        current=self.inspect(self.target.old)
        if current['Id']!=self.old['Id'] or current['State']['Running']: raise RuntimeError('Source container changed or is still running; removal cancelled.')
        self.docker('rm',self.old['Id']) # Exact inspected ID; deliberately no -f or -v.
        self.old_removed=True; self.record('legacy-container-removed')

    def start_database(self):
        self.new_started=True
        self.compose('up','-d','--no-build','--pull','never','--wait','--wait-timeout','180','db','pgadmin')

    def import_data(self,expected):
        result=self.compose('--profile','migration','run','--rm','migrate-json')
        line=next((line for line in result.stdout.splitlines() if line.startswith('Imported into PostgreSQL: ')),None)
        if not line: raise RuntimeError('Importer did not report successful counts.')
        imported=json.loads(line.split(': ',1)[1])
        for key in ['users','plans','uploads']:
            if imported[key]!=expected[key]: raise RuntimeError('Migration count mismatch: '+key)
        self.record('data-imported',counts=imported)

    def wait_http(self,port,path,postgres=False):
        deadline=time.monotonic()+120
        while time.monotonic()<deadline:
            try:
                with urllib.request.urlopen('http://127.0.0.1:'+str(port)+path,timeout=3) as response:
                    body=response.read()
                    if response.status==200 and (not postgres or json.loads(body).get('database')=='postgresql'): return
            except (OSError,ValueError): pass
            time.sleep(2)
        raise RuntimeError('The new service did not become healthy on port '+str(port)+'.')

    def start_app(self):
        self.compose('up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','app')
        actual=self.inspect(self.compose('ps','-q','app').stdout.strip())
        environment=dict(item.split('=',1) for item in actual['Config']['Env'])
        if any(environment.get(k)!=v for k,v in self.runtime.items()): raise RuntimeError('The application environment differs from the saved settings.')
        self.wait_http(self.target.app_port,'/health',postgres=True)
        self.wait_http(self.target.pgadmin_port,'/misc/ping')
        self.runtime['DISABLE_SCHEDULER']=self.resume_scheduler
        private_write(self.root/'.app.env',raw_env(self.runtime))
        self.compose('up','-d','--no-deps','--no-build','--pull','never','--wait','--wait-timeout','120','app')
        self.wait_http(self.target.app_port,'/health',postgres=True)

    def rollback(self):
        if self.new_started: self.compose('stop','app',check=False)
        if self.old_removed:
            if self.inspect(self.target.old,optional=True): raise RuntimeError('A container has taken the original name; automatic rollback will not replace it.')
            self.docker(*restore_arguments(self.old,self.backup/'legacy-runtime.env'))
            self.docker('start',self.target.old)
            print('Deployment failed; the old planner was recreated from its saved configuration.',flush=True)
        elif self.old_stopped:
            self.docker('start',self.old['Id']); print('The old planner has been restarted.',flush=True)

    def execute(self,verify_archive=True,prepare_images=None):
        print('1/6 Checking the package, ports and exact planner identity.',flush=True)
        manifest=self.verify_package() if verify_archive else None
        self.preflight()
        if prepare_images: prepare_images()
        if manifest:
            print('Loading the three planner-specific images. Other running containers are not restarted.',flush=True)
            self.docker('image','load','--input',self.root/'images.tar')
            for image,expected in manifest['images'].items():
                actual=self.docker('image','inspect','--format','{{.Id}}',image).stdout.strip()
                if actual!=expected: raise RuntimeError('Unexpected image identity for '+image)
        try:
            print('2/6 Saving the old image/configuration and preparing private settings.',flush=True)
            legacy=self.prepare_backup(); self.prepare_settings(legacy)
            print('3/6 Stopping only the old planner, validating its backup, then removing that container.',flush=True)
            counts=self.stop_and_snapshot(); self.remove_old()
            print('4/6 Starting this planner’s dedicated PostgreSQL and pgAdmin.',flush=True)
            self.start_database()
            print('5/6 Importing the server’s accounts, tasks, budgets and images.',flush=True)
            self.import_data(counts)
            print('6/6 Starting the planner on port '+str(self.target.app_port)+' and checking both services.',flush=True)
            self.start_app()
            changed=self.verify_unrelated()
            private_write(self.root/'ACCESS.txt','Planner port: '+str(self.target.app_port)+'\npgAdmin: localhost:'+str(self.target.pgadmin_port)+'\npgAdmin email: '+self.settings['PGADMIN_EMAIL']+'\npgAdmin password: '+self.settings['PGADMIN_PASSWORD']+'\nDatabase connection password (APP_DB_PASSWORD): '+self.settings['APP_DB_PASSWORD']+'\n')
            self.record('complete',counts=counts,other_containers_changed=changed)
            print('DONE. Existing planner passwords still work. pgAdmin credentials are in ACCESS.txt (private).',flush=True)
            print('Legacy files and verified backups were retained at '+str(self.backup),flush=True)
        except BaseException as error:
            try: self.rollback()
            except Exception as restore_error: print('Automatic rollback needs attention: '+str(restore_error),file=sys.stderr,flush=True)
            self.record('failed',error=str(error))
            self.verify_unrelated()
            raise

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--status',action='store_true')
    args=parser.parse_args()
    root=Path(__file__).resolve().parent
    if args.status:
        state=root/'deployment-state.json'
        print(state.read_text(encoding='utf-8') if state.exists() else 'Not deployed from this directory.');return
    if platform.system()!='Linux' or platform.machine().lower() not in ['x86_64','amd64']: raise RuntimeError('Run this package on the Linux x86_64 server, not on the Windows PC.')
    if not shutil.which('docker'): raise RuntimeError('Docker CLI is required.')
    os.umask(0o077)
    Deployment(root).execute()

if __name__=='__main__':
    try: main()
    except (Exception,KeyboardInterrupt) as error:
        print('STOPPED: '+str(error)+'\nKeep this directory and the backup. Send the error text for guidance, not ACCESS.txt or environment files.',file=sys.stderr)
        sys.exit(1)

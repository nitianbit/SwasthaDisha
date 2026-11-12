"""Fixed reviewed pure fixture campaign. Default invocation starts no child."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time

BASE=Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/pharmacy-pure-recovery')
QA=BASE/'output/qa/pharmacy-pure-fixture-recovery'
SOURCES=BASE/'test/inventory-runtime/scenario'
NODE=Path('/private/tmp/m0-node22/node')
NODE_SHA='2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0'
PYTHON=Path('/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14')
PYTHON_SHA='87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634'
CONTRACT_SHA='d5262defa2dc94e76772b18dcc54e0fbd9b294c9a937653d022efd49ac966b01'
BASELINE_SHA='f4a49fcbe8be8063091a4a1b9b76ea9e300a96e7eef19d9ed5192a3297b28690'
sha=lambda data:hashlib.sha256(data).hexdigest()

def need(ok,message):
    if not ok:raise RuntimeError(message)
def ident(info):return info.st_dev,info.st_ino,info.st_uid

def read(path,cap=2097152):
    for parent in [path.parent,*path.parent.parents]:need(stat.S_ISDIR(parent.lstat().st_mode),'directory/symlink refused')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=cap,'regular bounded file required')
        chunks=[];total=0
        while part:=os.read(fd,65536):
            total+=len(part);need(total<=cap,'input grew');chunks.append(part)
        need(ident(path.lstat())==ident(info),'source identity drift')
        return b''.join(chunks)
    finally:os.close(fd)

def new_file(path,data,on_create=None):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        if on_create is not None:on_create(ident(os.fstat(fd)))
        with os.fdopen(fd,'wb',closefd=False) as stream:stream.write(data);stream.flush();os.fsync(fd)
        info=os.fstat(fd);need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and ident(path.lstat())==ident(info),'new file identity drift')
        return ident(info)
    finally:os.close(fd)

def encode(data):return (json.dumps(data,indent=2)+'\n').encode()

def preflight():
    need(sys.argv==[str(QA/'run-pure.py'),'--run-once'],'fixed invocation required')
    need(Path(sys.executable)==PYTHON and sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode,'pinned isolated Python required')
    need(sha(read(PYTHON,134217728))==PYTHON_SHA,'Python digest changed')
    need(set(os.environ)<={'PATH','LC_ALL','LC_CTYPE','__CF_USER_TEXT_ENCODING'},'ambient override refused')
    if '__CF_USER_TEXT_ENCODING' in os.environ:
        value=os.environ['__CF_USER_TEXT_ENCODING'];need(0<len(value)<=128 and value.isascii() and re.fullmatch(r'0x[0-9a-fA-F]+:0x[0-9a-fA-F]+:0x[0-9a-fA-F]+',value),'encoding metadata refused')
    freeze_bytes=read(QA/'SOURCE_FREEZE_2.json');freeze=json.loads(freeze_bytes)
    snapshot=capture_snapshot(freeze_bytes)
    need(sha(snapshot['captured']['documentation/planning/implementation/PHARMACY_PURE_FIXTURE_RECOVERY_CONTRACT_DRAFT.md'])==CONTRACT_SHA,'contract drift')
    verify_node(freeze['nodeIdentity'])
    approval=json.loads(read(QA/'EXECUTION_ADMISSION.json'))
    need(set(approval)=={'schema','freezeSha256','launcherSha256','nodeSha256','reviews'},'closed admission required')
    need(approval['schema']=='SD-PHARMACY-PURE-ONE-CAMPAIGN-1' and approval['freezeSha256']==sha(freeze_bytes) and approval['launcherSha256']==sha(snapshot['captured']['output/qa/pharmacy-pure-fixture-recovery/run-pure.py']) and approval['nodeSha256']==NODE_SHA,'exact campaign admission required')
    reviews=approval['reviews']
    need(len(reviews)==2 and {r['role'] for r in reviews}=={'Spec','Standards'} and len({r['reviewer'] for r in reviews})==2,'two distinct reviews required')
    need(all(set(r)=={'role','reviewer','decision'} and r['decision']=='APPROVE_ONE_PURE_CAMPAIGN_ONLY' and r['reviewer']!='/root/pharmacy_recovery_readiness' for r in reviews),'execution reviews missing')
    need(not os.path.lexists(QA/'RUN_RESULT.json') and not os.path.lexists(QA/'RUN_RECORDS'),'existing campaign evidence refused')
    return snapshot

def capture_snapshot(freeze_bytes):
    freeze=json.loads(freeze_bytes);captured={}
    for name,digest in freeze['inputs'].items():
        data=read(BASE/name);need(sha(data)==digest,'frozen source drift: '+name);captured[name]=data
    plan=json.loads(captured['output/qa/pharmacy-pure-fixture-recovery/PLAN.json'])
    files={name:captured['test/inventory-runtime/scenario/'+name] for name in plan['sourceFiles']}
    files['baseline-bootstrap.cjs']=captured['output/qa/pharmacy-fixture-recovery/restored/blobs/'+BASELINE_SHA+'.txt']
    need(sha(files['baseline-bootstrap.cjs'])==BASELINE_SHA,'baseline drift')
    return {'freezeBytes':freeze_bytes,'freeze':freeze,'captured':captured,'plan':plan,'files':files}

def verify_node(expected):
    info=NODE.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_mode&0o777==0o500 and ident(info)==tuple(expected),'Node identity/mode drift')
    need(sha(read(NODE,134217728))==NODE_SHA,'Node digest drift')

def error_record(error):return {'type':type(error).__name__,'message':str(error)[:512]}

def run_child(lease,entry,node_identity):
    argv=[str(NODE),'--permission','--allow-fs-read='+str(lease),str(lease/entry)]
    result={'argv':argv,'started':False,'pid':None,'exitCode':None,'attemptMonotonic':time.monotonic(),'startMonotonic':None,'failure':None,'cleanupErrors':[]}
    child=None;output={'stdout':bytearray(),'stderr':bytearray()};readable=set()
    def retain(error):
        if result['failure'] is None:result['failure']=error_record(error)
    def cleanup_error(error):
        if len(result['cleanupErrors'])<8:result['cleanupErrors'].append(error_record(error))
    def capture(name,chunk):
        remaining=1048576-sum(map(len,output.values()));output[name].extend(chunk[:max(0,remaining)])
        need(len(chunk)<=remaining,'OUTPUT_CAP')
    try:
        verify_node(node_identity)  # Every command, immediately before Popen.
        child=subprocess.Popen(argv,cwd=lease,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        result.update(started=True,pid=child.pid,startMonotonic=time.monotonic())
        with selectors.DefaultSelector() as selected:
            for name,pipe in [('stdout',child.stdout),('stderr',child.stderr)]:
                os.set_blocking(pipe.fileno(),False);readable.add(name);selected.register(pipe,selectors.EVENT_READ,name)
            while selected.get_map():
                need(time.monotonic()-result['startMonotonic']<30,'PROCESS_DEADLINE')
                for key,_ in selected.select(0.1):
                    chunk=os.read(key.fileobj.fileno(),65536)
                    if not chunk:selected.unregister(key.fileobj);continue
                    capture(key.data,chunk)
        child.wait(timeout=5)
    except BaseException as error:retain(error)
    finally:
        if child is not None:
            try:
                if child.poll() is None:os.killpg(child.pid,signal.SIGKILL)
            except BaseException as error:cleanup_error(error)
            try:child.wait(timeout=5)
            except BaseException as error:cleanup_error(error)
            # Preserve bounded tails after selector/read/wait failures as well.
            for name,pipe in [('stdout',child.stdout),('stderr',child.stderr)]:
                try:
                    if name in readable:
                        while True:
                            try:chunk=os.read(pipe.fileno(),65536)
                            except BlockingIOError:break
                            if not chunk:break
                            capture(name,chunk)
                except BaseException as error:cleanup_error(error)
                try:pipe.close()
                except BaseException as error:cleanup_error(error)
            result['exitCode']=child.returncode
        result.update(stdout=bytes(output['stdout']),stderr=bytes(output['stderr']))
    return result

def subject(job,files,records,node_identity):
    lease=Path('/private/tmp')/('sd-pharmacy-pure-'+secrets.token_hex(16))
    lease_fd=None;owner=None;owned={};allocated=False;record_owner=None;record_allocated=False;record_dir=records/job['id']
    result={'id':job['id'],'lease':str(lease),'leaseIdentity':None,'recordDirectory':str(record_dir),'started':False,'cleanup':'NOT_ALLOCATED','cleanupErrors':[],'unresolvedPaths':[]}
    try:
        lease.mkdir(mode=0o700);allocated=True
        owner=ident(lease.lstat());result['leaseIdentity']=owner  # Capture before opening/allocating anything else.
        lease_fd=os.open(lease,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);need(ident(os.fstat(lease_fd))==owner,'lease identity drift')
        record_dir.mkdir(mode=0o700);record_allocated=True;record_owner=ident(record_dir.lstat())
        for name,data in files.items():
            new_file(lease/name,data,on_create=lambda key,name=name:owned.__setitem__(name,key))
            new_file(record_dir/(name+'.txt'),data)
        need(set(p.name for p in lease.iterdir())==set(files),'unexpected lease file')
        result.update(run_child(lease,job['entry'],node_identity))
        stdout=result.pop('stdout');stderr=result.pop('stderr')
        new_file(record_dir/'stdout.txt',stdout);new_file(record_dir/'stderr.txt',stderr)
        result.update(stdoutSha256=sha(stdout),stderrSha256=sha(stderr),sourceHashes={n:sha(b) for n,b in files.items()})
        need(result['failure'] is None and not result['cleanupErrors'] and not stderr,'process/cleanup/stderr failure')
        lines=stdout.decode().splitlines();need(len(lines)==1,'one complete JSON summary required');summary=json.loads(lines[0]);result['summary']=summary
        if job.get('control'):
            need(result['exitCode']!=0 and summary.get('status')=='FAIL' and summary.get('schema')=='SD-CURSOR-CREATION-PURE-1' and summary.get('sourceMode')==job['id'] and summary.get('test')==job['expectedFailingCase'] and summary.get('failed')==1,'required named weakening not detected')
        else:
            need(result['exitCode']==0 and summary.get('status')=='PASS' and summary.get('schema')==job['schema'] and summary.get('checks')==job['checks'] and summary.get('failed')==0,'required corpus incomplete')
            need(all(summary.get(key)==0 for key in ['applicationEvaluations','packageEvaluations','DockerCalls']),'forbidden effects reported')
            if job['entry']=='cursor-creation-pure.test.cjs':need(summary.get('sourceMode')=='normal' and summary.get('caseIds')==job['caseIds'],'new case set incomplete')
        result['status']='EXPECTED_CONTROL_REJECTED' if job.get('control') else 'PURE_ENTRY_COMPLETE'
    except BaseException as error:
        result.update(status='FAILED',firstFailure=result.get('failure') or error_record(error))
    finally:
        if allocated:
            try:
                need(owner is not None and stat.S_ISDIR(lease.lstat().st_mode) and ident(lease.lstat())==owner,'lease ownership unresolved')
                for name,key in owned.items():
                    need(lease_fd is not None and ident(lease.lstat())==owner,'lease path/fd drift')
                    info=os.stat(name,dir_fd=lease_fd,follow_symlinks=False);need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and ident(info)==key,'cleanup identity drift');os.unlink(name,dir_fd=lease_fd)
                lease.rmdir();need(not os.path.lexists(lease),'lease reappeared');result['cleanup']='VERIFIED_FRESH_ABSENCE'
            except BaseException as error:
                result['cleanup']='EXCEPTION';result['cleanupErrors'].append(error_record(error));result['unresolvedPaths'].append(str(lease))
                try:result['unresolvedPaths'] += [str(p) for p in lease.iterdir()][:16]
                except OSError:pass
        if lease_fd is not None:
            try:os.close(lease_fd)
            except BaseException as error:result['cleanupErrors'].append(error_record(error))
        if result['cleanupErrors']:result['status']='FAILED'
        result['recordPersisted']=False
        if record_allocated and record_owner is None:
            result['status']='FAILED';result['unresolvedPaths'].append(str(record_dir))
        if record_owner is not None:
            try:
                need(ident(record_dir.lstat())==record_owner,'record directory drift')
                result['recordPersisted']=True;new_file(record_dir/'result.json',encode(result))
            except BaseException as error:
                result['recordPersisted']=False;result['status']='FAILED';result['cleanupErrors'].append(error_record(error));result['unresolvedPaths'].append(str(record_dir))
    return result

def main():
    if len(sys.argv)==1:print(json.dumps({'status':'NO_EFFECTS_DEFAULT','NodeExecutions':0}));return 0
    snapshot=preflight()
    new_file(QA/'RUN_ONCE.json',encode({'status':'CONSUMED_BEFORE_ALLOCATION','freezeSha256':sha(snapshot['freezeBytes'])}))
    plan=snapshot['plan'];files=snapshot['files'];results=[];campaign_failure=None
    records=QA/'RUN_RECORDS'
    try:
        records.mkdir(mode=0o700)
        for job in plan['jobs']:
            inputs=dict(files)
            if job.get('control'):
                original=inputs['bootstrap.cjs'].decode();need(original.count(job['before'])==1,'control inverse mismatch');inputs['bootstrap.cjs']=original.replace(job['before'],job['after']).encode();need(sha(inputs['bootstrap.cjs'])==job['sha256'],'control bytes mismatch')
            result=subject(job,inputs,records,snapshot['freeze']['nodeIdentity']);results.append(result)
            if result['status']=='FAILED':break
    except BaseException as error:campaign_failure=error_record(error)
    complete=campaign_failure is None and len(results)==len(plan['jobs']) and all(r['status']!='FAILED' for r in results)
    report={'status':'PURE_CAMPAIGN_COMPLETE' if complete else 'FAILED_REVIEW_REQUIRED','results':results,'firstCampaignFailure':campaign_failure,'NodeEntriesStarted':sum(r.get('started') is True for r in results),'applicationAcceptance':False,'driverOrDBAcceptance':False,'lostHistoricalQARemainsMissing':True,'writesStopped':True}
    new_file(QA/'RUN_RESULT.json',encode(report));print(json.dumps(report));return int(not complete)

if __name__=='__main__':
    try:raise SystemExit(main())
    except (RuntimeError,OSError,ValueError,KeyError,TypeError) as error:
        print(json.dumps({'status':'REFUSED_OR_FAILED','errorType':type(error).__name__,'message':str(error)[:512]}));raise SystemExit(1)

"""One internally reviewed diagnostic invocation; cached image only, no retry."""
import hashlib,json,os,pathlib,re,stat,subprocess,tempfile,time,uuid
ROOT=pathlib.Path('/private/tmp/swasthadisha-parallel-p1qom53w/diagnostic-41539')
APPROVED='41539ca749c8a9dbf49ecf43bcca00749eccfe3c'
NODE='/private/tmp/m0-node22/node'
DOCKER='/usr/local/bin/docker'
ENDPOINT='unix:///Users/shubham/.docker/run/docker.sock'
ENGINE='16ab25f6-88c7-4687-a431-b119b6ab9319'
IMAGE='node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d'
AREA=pathlib.Path(tempfile.mkdtemp(prefix='sd-reviewed-network-diag-',dir='/private/tmp'))
identity=AREA.lstat();owner=str(uuid.uuid4())
(AREA/'.operator-owner.json').write_text(json.dumps({'runId':owner,'approved_commit':APPROVED})+'\n')
os.chmod(AREA/'.operator-owner.json',0o600)
CONFIG=AREA/'docker';CONFIG.mkdir(mode=0o700)
(CONFIG/'config.json').write_text('{"auths":{}}\n');os.chmod(CONFIG/'config.json',0o600)
config_identity=CONFIG.lstat()
report={'approved_commit':APPROVED,'operator_directory':str(AREA),'operator_run_id':owner,'started_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'status':'IN_PROGRESS','launcher_invocations':0,'commands':[],'resources':{},'approval':'User delegated direct internal reviews; independent internal Standards and Spec approvals bound to revision-2. Exactly one diagnostic-enabled smoke; no post-create retry'}
def save():
    (AREA/'operator-result.json').write_text(json.dumps(report,indent=2)+'\n')
def owned():
    s=AREA.lstat();c=CONFIG.lstat()
    assert stat.S_ISDIR(s.st_mode) and (s.st_dev,s.st_ino)==(identity.st_dev,identity.st_ino)
    assert stat.S_ISDIR(c.st_mode) and (c.st_dev,c.st_ino)==(config_identity.st_dev,config_identity.st_ino)
    assert json.loads((AREA/'.operator-owner.json').read_text())['runId']==owner
    assert (CONFIG/'config.json').read_text()=='{"auths":{}}\n'
def git(*args):
    return subprocess.run(['git',*args],cwd=ROOT,capture_output=True,check=True).stdout

def freeze(label):
    assert git('rev-parse','HEAD').decode().strip()==APPROVED
    assert git('branch','--show-current').decode().strip()==''
    assert git('status','--porcelain','--untracked-files=all')==b''
    manifest_path='output/review/app-isolation/revision-2/review-input.json'
    manifest_bytes=(ROOT/manifest_path).read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest()=='54b7192be002ee191447547684fcfbbcfff4cc635c95316c4e1ed163350e9e0b','Unreviewed manifest'
    assert git('show',APPROVED+':'+manifest_path)==manifest_bytes
    manifest=json.loads(manifest_bytes)
    records={}
    for group in ['files','evidence_sha256','historical_inputs_sha256']:
        for path,digest in manifest[group].items():
            assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==digest,path
        records[group]=len(manifest[group])
    patch=ROOT/'output/review/app-isolation/revision-2/candidate.diff'
    assert hashlib.sha256(patch.read_bytes()).hexdigest()==manifest['patch_sha256']
    helper='src1/modules/common/utils/queryUtils.ts'
    assert hashlib.sha256((ROOT/helper).read_bytes()).hexdigest()=='fb65a0b563b5035d87c8d41e80dfe5f91a5382de02c83d0b6ceac630c89f018d'
    record={'commit':APPROVED,'working_tree':'clean','manifest_sha256':hashlib.sha256(manifest_bytes).hexdigest(),'verified_counts':records,'helper_sha256':manifest['files'][helper],'operator_directory_outside_checkout':True}
    (AREA/(label+'.json')).write_text(json.dumps(record,indent=2)+'\n')
    return record

def docker(step,args,timeout=25):
    owned()
    command=[DOCKER,'--config',str(CONFIG),'--host',ENDPOINT,*args]
    with (AREA/(step+'.stdout.txt')).open('w') as stdout,(AREA/(step+'.stderr.txt')).open('w') as stderr:
        run=subprocess.run(command,env={'PATH':'/usr/local/bin:/usr/bin:/bin'},cwd=AREA,stdout=stdout,stderr=stderr,text=True,timeout=timeout)
    record={'step':step,'args':args,'exit_code':run.returncode,'stdout':step+'.stdout.txt','stderr':step+'.stderr.txt'}
    report['commands'].append(record);save()
    return run.returncode,(AREA/(step+'.stdout.txt')).read_text(),(AREA/(step+'.stderr.txt')).read_text()

def engine(step):
    code,out,err=docker(step,['info','--format','[{{json .ID}},{{json .OSType}}]'])
    assert code==0,(step,code,err)
    assert json.loads(out)==[ENGINE,'linux'],(step,out)

def labels(step):
    code,out,err=docker(step,['ps','--all','--filter','label=swasthadisha.test.purpose=app-isolation','--quiet','--no-trunc'])
    assert code==0,(step,code,err)
    rows=out.split();report[step+'_count']=len(rows);save();return rows

print(json.dumps({'operator_directory':str(AREA),'phase':'preflight'}),flush=True)
save()
try:
    report['source_freeze_before_image_check']=freeze('source-freeze-before-image-check')
    assert hashlib.sha256(pathlib.Path(NODE).read_bytes()).hexdigest()=='2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0','Unreviewed host Node binary'
    version=subprocess.run([NODE,'--version'],env={},capture_output=True,text=True,check=True).stdout.strip()
    assert version=='v22.23.4',version
    report['host_node']={'version':version,'binary_sha256':hashlib.sha256(pathlib.Path(NODE).read_bytes()).hexdigest()}
    socket=pathlib.Path('/Users/shubham/.docker/run/docker.sock');assert stat.S_ISSOCK(socket.resolve().stat().st_mode)
    report['socket']={'endpoint':ENDPOINT,'resolved':str(socket.resolve())}
    engine('engine-before-image-check')
    assert labels('labels-before-image-check')==[],'Existing purpose-labelled resources; do not adopt or remove'
    save();print(json.dumps({'phase':'verify-cached-image','engine_verified':True}),flush=True)
    code,out,err=docker('image-inspect',['image','inspect',IMAGE]);assert code==0,err
    images=json.loads(out);assert len(images)==1
    image=images[0]
    assert re.fullmatch('sha256:[a-f0-9]{64}',image['Id']) and IMAGE in image['RepoDigests']
    assert image['Os']=='linux' and image['Architecture'] in ['amd64','arm64']
    assert not image['Config'].get('Volumes')
    entries=[entry.split('=',1) for entry in image['Config']['Env']]
    assert len(set(key for key,value in entries))==len(entries)
    assert {'PATH','NODE_VERSION'}.issubset(key for key,value in entries)
    assert all((key=='PATH' and value=='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin') or (key=='NODE_VERSION' and value=='22.23.4') or (key=='YARN_VERSION' and re.fullmatch('[0-9.]+',value)) for key,value in entries)
    report['cached_image']={'Id':image['Id'],'RepoDigests':image['RepoDigests'],'Os':image['Os'],'Architecture':image['Architecture']}
    engine('engine-before-launch')
    assert labels('labels-before-create')==[]
    report['source_freeze_before_launch']=freeze('source-freeze-before-launch')
    report['launcher_invocations']=1;save();print(json.dumps({'phase':'one-approved-launch','source_freeze':'verified'}),flush=True)
    try:
        with (AREA/'launcher.stdout.txt').open('w') as stdout,(AREA/'launcher.stderr.txt').open('w') as stderr:
            run=subprocess.run([NODE,'test/application/run.mjs',ENDPOINT],env={},cwd=ROOT,stdout=stdout,stderr=stderr,text=True,timeout=300)
        report['launcher_exit_code']=run.returncode
    except subprocess.TimeoutExpired:
        report['launcher_timeout']=True;report['launcher_exit_code']=None
    stdout=(AREA/'launcher.stdout.txt').read_text();stderr=(AREA/'launcher.stderr.txt').read_text()
    for line in stderr.splitlines():
        try:entry=json.loads(line)
        except (ValueError,TypeError):continue
        if entry.get('phase')=='created' and re.fullmatch('[a-f0-9]{64}',entry.get('id','')):
            report['resources']={key:entry[key] for key in ['id','runId','directory']};break
    if not report['resources']:
        match=re.search(r'Application fixture unresolved; cleanup withheld for ([a-f0-9]{64}); workspace ([^\n]+)',stderr)
        if match:report['resources']={'id':match.group(1),'directory':match.group(2),'source':'controller error; no resource mutation authorized by printed ID alone'}
    report['internal_review']={'manifest_sha256':'54b7192be002ee191447547684fcfbbcfff4cc635c95316c4e1ed163350e9e0b','patch_sha256':'efa341314e0c7787651b7b65722dd5a5ab3ebda3bde9b7826ddeab457feca3a3','review_scope':'one diagnostic-enabled fixed no-DB smoke; current source freeze; cached image only'}
    diagnostics=[]
    for line in stderr.splitlines():
        start=line.find('{"tag":"APP-NET-DIAG-1"')
        if start>=0:
            try:
                record,end=json.JSONDecoder().raw_decode(line[start:])
                diagnostics.append({'record':record,'bytes':len(line[start:start+end].encode())})
            except ValueError:
                report['diagnostic_parse_error']=True
    report['network_diagnostics']=diagnostics
    report['diagnostic_matched_run_id']=bool(resource_id:=report['resources'].get('runId')) and len(diagnostics)==1 and diagnostics[0]['record'].get('runId')==resource_id
    report['diagnostic_within_bounds']=len(diagnostics)==1 and diagnostics[0]['bytes']<=8192
    strict_line=next(i for i,line in enumerate((ROOT/'test/application/bootstrap.mjs').read_text().splitlines(),1) if line=="assert.deepEqual(networkInterfaces, ['lo']);")
    report['strict_interface_guard_line']=strict_line
    report['failure_at_strict_interface_guard']=bool(re.search(r'bootstrap\.mjs:'+str(strict_line)+r':\d+',stderr))
    save()
    engine('engine-after-launch')
    remaining=labels('labels-after-launch')
    resource=report['resources']
    if resource:
        code,inspect_out,inspect_err=docker('exact-container-after-launch',['container','inspect',resource['id']])
        absent=code!=0 and bool(re.search(r'No such (?:object|container)',inspect_err)) and resource['id'] in inspect_err
        report['independent_container_absent']=absent
        report['independent_workspace_absent']=not os.path.lexists(resource['directory'])
        report['exact_container_readback_exit_code']=code
    report['source_freeze_after_launch']=freeze('source-freeze-after-launch')
    save()
    if report['launcher_exit_code']==0:
        result=json.loads(stdout)
        operations={'payments':'create-order','sms':'send','email':'send','push':'send','calendar':'create-event','storage':'put','queue':'enqueue'}
        assert result['admissionPassed'] is True and result['egressBlocked'] is True and result['filesystemCanariesPassed'] is True
        assert result['databaseMode']=='not-admitted' and result['networkInterfaces']==['lo']
        assert result['scenario']=={'literalSearchPassed':True,'unknownOperationRejected':True}
        assert len(result['calls'])==7 and {call['port'] for call in result['calls']}==set(operations)
        assert all(call['operation']==operations[call['port']] and call['effect'] is False and call['status']=='recorded' for call in result['calls'])
        assert result['cleanupAcknowledged'] is True and result['containerId']==resource['id'] and result['directory']==resource['directory']
        assert report['independent_container_absent'] and report['independent_workspace_absent'] and remaining==[]
        report['status']='PASS';report['result']=result
    else:
        report['status']='FAIL' if resource and report.get('independent_container_absent') and report.get('independent_workspace_absent') and remaining==[] else 'UNRESOLVED'
        report['review_required_before_retry']=True
except Exception as error:
    report['status']='UNRESOLVED' if report['launcher_invocations'] else 'BLOCKED_BEFORE_LAUNCH'
    report['operator_error']={'type':type(error).__name__,'message':str(error)}
finally:
    report['finished_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save()
    print(json.dumps({'operator_directory':str(AREA),'status':report['status'],'launcher_invocations':report['launcher_invocations'],'resources':report['resources'],'operator_error':report.get('operator_error')}),flush=True)

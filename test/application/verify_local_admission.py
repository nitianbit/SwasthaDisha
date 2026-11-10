"""Companion offline probes: real link metadata, fake launcher, permission metadata."""
import hashlib,json,pathlib,re,shutil,subprocess,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'output/qa/m0-a/app-isolation/revision-1'
NODES={'node22':'/private/tmp/m0-node22/node','node24':'/Users/shubham/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'}
NAMES=['app-bundle.mjs','app-ports.mjs','bootstrap.mjs','package.json','queryUtils.ts','scenario.mjs']
RUN_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
results=[]
for runtime,node in NODES.items():
    for kind in ['regular','symlink','hardlink']:
        with tempfile.TemporaryDirectory(prefix='sd-link-probe-',dir='/private/tmp') as area:
            parent=pathlib.Path(area);bundle=parent/'bundle';bundle.mkdir()
            data=b'synthetic fixture text, never imported\n'
            hashes={name:hashlib.sha256(data).hexdigest() for name in NAMES}
            for name in NAMES:(bundle/name).write_bytes(data)
            manifest=json.dumps({'runId':RUN_ID,'role':'synthetic-ports-only','files':hashes}).encode()
            (bundle/'.admission.json').write_bytes(manifest)
            expected={'runId':RUN_ID,'manifestSha':hashlib.sha256(manifest).hexdigest()}
            target=parent/'owned-payload';target.write_bytes(data)
            if kind!='regular':
                replacement=bundle/'scenario.mjs';replacement.unlink()
                if kind=='symlink':replacement.symlink_to(target)
                else:replacement.hardlink_to(target)
            module=(ROOT/'test/application/app-bundle.mjs').as_uri()
            program='import {assertBundle} from '+json.dumps(module)+';\n'
            program+='let continuations=0;let rejected=false;try{assertBundle('+json.dumps(str(bundle))+','+json.dumps(expected)+');continuations++;}catch(error){if(!/Bundle file identity changed/.test(error.message))throw error;rejected=true;}\n'
            program+='console.log(JSON.stringify({rejected,continuations}));\n'
            entry=parent/'probe.mjs';entry.write_text(program)
            command=[node,'--permission','--allow-fs-read='+str(parent),'--allow-fs-read='+str(ROOT/'test/application'),str(entry)]
            run=subprocess.run(command,env={'TMPDIR':str(parent)},capture_output=True,text=True,timeout=15)
            assert run.returncode==0,run.stderr
            observed=json.loads(run.stdout)
            assert observed=={'rejected':kind!='regular','continuations':1 if kind=='regular' else 0},observed
            results.append({'runtime':runtime,'probe':'bundle-'+kind,'exit_code':run.returncode,'observed':observed,'all_payloads_synthetic':True})
        assert not parent.exists()

    for mode in ['success','failure','interrupted']:
        with tempfile.TemporaryDirectory(prefix='sd-launcher-probe-',dir='/private/tmp') as area:
            parent=pathlib.Path(area);workspace=parent/'owned-workspace';workspace.mkdir()
            shutil.copyfile(ROOT/'test/application/run.mjs',parent/'run.mjs')
            fake="import {rmSync} from 'node:fs';\n"
            fake+='export function createApplicationFixture(){return {id:'+json.dumps('d'*64)+',runId:'+json.dumps(RUN_ID)+',directory:'+json.dumps(str(workspace))+',image:"synthetic-not-a-real-image",\n'
            fake+='run(){console.error(JSON.stringify({phase:"run-entered"}));'
            if mode=='failure':fake+='throw new Error("synthetic run failure");'
            elif mode=='interrupted':fake+='Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);'
            else:fake+='return {synthetic:true};'
            fake+='},dispose(){rmSync(this.directory,{recursive:true,force:false});}};}\n'
            (parent/'app-container.mjs').write_text(fake)
            command=[node,str(parent/'run.mjs'),'unix:///synthetic/not-connected.sock']
            process=subprocess.Popen(command,env={'TMPDIR':str(parent)},cwd=parent,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            interrupted=False
            try:
                try:stdout,stderr=process.communicate(timeout=1 if mode=='interrupted' else 15)
                except subprocess.TimeoutExpired:
                    interrupted=True;process.terminate();stdout,stderr=process.communicate(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill();process.communicate(timeout=10)
            lines=stderr.splitlines();first=json.loads(lines[0])
            assert first=={'phase':'created','id':'d'*64,'runId':RUN_ID,'directory':str(workspace)},stderr
            assert lines[1]=='{"phase":"run-entered"}',stderr
            if mode=='success':assert process.returncode==0 and json.loads(stdout)['cleanupAcknowledged'] and not workspace.exists()
            elif mode=='failure':assert process.returncode!=0 and 'synthetic run failure' in stderr and not workspace.exists()
            else:assert interrupted and process.returncode!=0 and workspace.exists()
            results.append({'runtime':runtime,'probe':'launcher-'+mode,'exit_code':process.returncode,'resource_record_first':True,'interrupted':interrupted,'factory_replaced_with_simulation':True,'docker_or_app_calls':0})
        assert not parent.exists()

    bootstrap=(ROOT/'test/application/bootstrap.mjs').read_text()
    scope=re.search(r"permission\.has\('(addons?)'\)",bootstrap).group(1)
    for allowed in [False,True]:
        flags=['--permission']+(['--allow-addons'] if allowed else [])
        program='console.log(JSON.stringify({granted:process.permission.has('+json.dumps(scope)+')}))'
        run=subprocess.run([node,*flags,'-e',program],env={},capture_output=True,text=True,timeout=15)
        assert run.returncode==0 and json.loads(run.stdout)['granted']==allowed,(scope,run.stdout,run.stderr)
        results.append({'runtime':runtime,'probe':'addon-scope','scope_from_bootstrap':scope,'flag_present':allowed,'granted':allowed,'addon_loaded':False,'expected_security_warning':bool(run.stderr)})

OUT.mkdir(parents=True,exist_ok=True)
proof={'mode':'offline; link files are synthetic, launcher factory simulated, addon probes query permission metadata only','application_evaluation':False,'docker_calls':0,'outer_fixtures_removed':True,'source_sha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['test/application/app-bundle.mjs','test/application/bootstrap.mjs','test/application/run.mjs','test/application/verify_local_admission.py']},'results':results}
(OUT/'companion-probes.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'checks':len(results),'runtimes':list(NODES),'all_expected_results':True,'docker_calls':0,'application_evaluation':False}))

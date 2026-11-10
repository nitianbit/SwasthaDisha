"""Offline regression detection against reviewed old controller, never real Docker."""
import hashlib,json,pathlib,shutil,subprocess,tempfile
root=pathlib.Path(__file__).resolve().parents[5]
out=pathlib.Path(__file__).resolve().parent
baseline='58980c698bdfcdee5b2eb68d5c8a7577e6758e4d'
paths=['test/foundation/run.mjs','test/foundation/preflight.mjs','test/foundation/preflight.test.mjs','test/foundation/mongo-fixture.mjs','test/foundation/mongo-fixture.test.mjs','test/application/app-container.mjs','test/application/app-container.test.mjs','test/application/app-bundle.mjs','test/application/app-bundle.test.mjs','test/application/app-ports.mjs','test/application/app-image.json','test/application/app-runtime.json']
old=subprocess.run(['git','show',baseline+':test/application/app-container.mjs'],cwd=root,capture_output=True,check=True).stdout
with tempfile.TemporaryDirectory(prefix='sd-old-controller-',dir='/private/tmp') as area:
    clone=pathlib.Path(area)
    for name in paths:
        target=clone/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,target)
    (clone/'test/application/app-container.mjs').write_bytes(old)
    run=subprocess.run(['/private/tmp/m0-node22/node',str(clone/'test/foundation/run.mjs')],env={'TMPDIR':'/private/tmp'},capture_output=True,text=True,timeout=45)
    (out/'old-controller.tap').write_text(run.stdout)
    (out/'old-controller.stderr.txt').write_text(run.stderr)
    assert run.returncode!=0,'Old controller unexpectedly passed amended regressions'
    import re
    failures=re.findall(r'^not ok \d+ - (.+)$',run.stdout,re.M)
    assert len(failures)==8,failures
    assert any('create acknowledgement is reported before' in name for name in failures),failures
    assert any('failed creation reporter' in name for name in failures),failures
assert not clone.exists()
proof={'mode':'offline historical-controller regression detection, not a live Docker reproduction','baseline':baseline,'exit_code':run.returncode,'expected':'nonzero','expected_early_reporter_failures':8,'all_failures':failures,'old_controller_sha256':hashlib.sha256(old).hexdigest(),'current_source_sha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in paths},'outer_fixture_removed':True,'application_evaluation':False,'real_docker_calls':0,'containment':'Staged unit child has no child-process permission; new admission regressions also trap allocation/socket/process attempts before effects. Only controller and synthetic unit fixtures are copied.'}
(out/'old-controller.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps({'expected_nonzero':True,'expected_early_reporter_failures':8,'all_failures':len(failures),'docker_calls':0}))

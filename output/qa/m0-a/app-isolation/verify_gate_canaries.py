"""Executable gate canaries; fixtures use only synthetic passing/failing tests."""
import hashlib,json,pathlib,shutil,subprocess,tempfile
root=pathlib.Path(__file__).resolve().parents[4]
out=pathlib.Path(__file__).resolve().parent
entries=['test/foundation/preflight.test.mjs','test/foundation/mongo-fixture.test.mjs','test/application/app-container.test.mjs','test/application/app-bundle.test.mjs']
paths=['test/foundation/run.mjs','test/foundation/preflight.mjs','test/foundation/preflight.test.mjs','test/foundation/mongo-fixture.mjs','test/foundation/mongo-fixture.test.mjs','test/application/app-container.mjs','test/application/app-container.test.mjs','test/application/app-bundle.mjs','test/application/app-bundle.test.mjs','test/application/app-ports.mjs','test/application/app-image.json','test/application/app-runtime.json']
nodes={'node22':'/private/tmp/m0-node22/node','node24':'/Users/shubham/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'}
positive="import {test} from 'node:test';\nimport assert from 'node:assert/strict';\ntest('positive one',()=>assert.ok(true));\ntest('positive two',()=>assert.equal(1,1));\n"
cases=['positive-control',*['empty-'+str(i) for i in range(4)],'all-empty','assertion-failure','required-skip','required-todo','source-symlink','preflight-bypass']
results=[]
for runtime,node in nodes.items():
    for case in cases:
        with tempfile.TemporaryDirectory(prefix='sd-app-gate-canary-',dir='/private/tmp') as area:
            clone=pathlib.Path(area)
            for name in paths:
                target=clone/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,target)
            for name in entries:(clone/name).write_text(positive)
            if case.startswith('empty-'):(clone/entries[int(case[-1])]).write_text('')
            if case=='all-empty':
                for name in entries:(clone/name).write_text('')
            actions={'assertion-failure':"test('required failing assertion',()=>assert.equal(1,2));\n",'required-skip':"test.skip('required skip',()=>assert.ok(true));\n",'required-todo':"test.todo('required TODO');\n"}
            if case in actions:(clone/entries[2]).write_text(positive+actions[case])
            if case=='source-symlink':
                target=clone/'test/application/app-image.json';target.unlink();target.symlink_to(root/'test/application/app-image.json')
            if case=='preflight-bypass':
                target=clone/'test/foundation/preflight.mjs';text=target.read_text();needle='export function assertLaunch(workspace, { cwd, env }) {';assert text.count(needle)==1;target.write_text(text.replace(needle,needle+'\n  return; // synthetic regression'))
            run=subprocess.run([node,str(clone/'test/foundation/run.mjs')],env={'TMPDIR':'/private/tmp'},capture_output=True,text=True,timeout=45)
            evidence=runtime+'-'+case+'.txt';(out/evidence).write_text(run.stdout+run.stderr)
            expected=0 if case=='positive-control' else 1
            assert (run.returncode==0)==(expected==0),(runtime,case,run.returncode)
            results.append({'runtime':runtime,'case':case,'exit_code':run.returncode,'expected':'zero' if expected==0 else 'nonzero','evidence':evidence})
(out/'gate-canaries.json').write_text(json.dumps({'mode':'synthetic runner canaries, not application acceptance','source_sha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in paths},'results':results},indent=2)+'\n')
print(json.dumps({'executed':len(results),'positive_controls':2,'expected_rejections':len(results)-2}))

"""Executable negative checks in owned temporary copies; never imports the app."""
import hashlib, json, pathlib, shutil, subprocess, tempfile

root = pathlib.Path(__file__).resolve().parents[4]
out = pathlib.Path(__file__).resolve().parent
sources = sorted((root / 'test/foundation').glob('*.mjs'))
nodes = {
    'node22': '/private/tmp/m0-node22/node',
    'node24': '/Users/shubham/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node',
}
cases = ['assertion-failure', 'required-skip', 'required-todo', 'both-empty',
         'one-empty-mongo', 'one-empty-preflight', 'preflight-bypassed',
         'symlink-source', 'image-snapshot-regression']
results = []
for runtime, node in nodes.items():
    for case in cases:
        with tempfile.TemporaryDirectory(prefix='sd-foundation-canary-') as directory:
            staged = pathlib.Path(directory)
            for source in sources:
                shutil.copyfile(source, staged / source.name)
            preflight_test = staged / 'preflight.test.mjs'
            if case in ['assertion-failure', 'required-skip', 'required-todo']:
                action = {
                    'assertion-failure': "test('required failing assertion', () => assert.equal(1, 2));",
                    'required-skip': "test.skip('required skipped case', () => assert.equal(1, 1));",
                    'required-todo': "test.todo('required TODO case');",
                }[case]
                preflight_test.write_text("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
                    + "test('positive one', () => assert.equal(1, 1));\ntest('positive two', () => assert.ok(true));\n" + action + '\n')
            if case in ['both-empty', 'one-empty-preflight']:
                preflight_test.write_text('')
            if case in ['both-empty', 'one-empty-mongo']:
                (staged / 'mongo-fixture.test.mjs').write_text('')
            if case == 'preflight-bypassed':
                target = staged / 'preflight.mjs'
                text = target.read_text()
                needle = 'export function assertLaunch(workspace, { cwd, env }) {'
                assert text.count(needle) == 1
                target.write_text(text.replace(needle, needle + '\n  return; // synthetic canary'))
            if case == 'symlink-source':
                preflight_test.unlink()
                preflight_test.symlink_to(root / 'test/foundation/preflight.test.mjs')
            if case == 'image-snapshot-regression':
                target = staged / 'mongo-fixture.mjs'
                text = target.read_text()
                before = '  request = Object.freeze({ ...request });\n  validateRequest(request);'
                after = '  validateRequest(request);\n  request = Object.freeze({ ...request });'
                assert text.count(before) == 1
                target.write_text(text.replace(before, after))
            run = subprocess.run([node, str(staged / 'run.mjs')],
                env={'TMPDIR': '/private/tmp'}, capture_output=True, text=True, timeout=45)
            evidence = f'{runtime}-final-{case}.txt'
            (out / evidence).write_text(run.stdout + run.stderr)
            results.append({'runtime': runtime, 'case': case, 'exit_code': run.returncode,
                            'expected': 'nonzero exit', 'evidence': evidence})
            assert run.returncode != 0, f'False passing gate: {runtime} {case}'
(out / 'negative-canaries-final.json').write_text(json.dumps({
    'source_sha256': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
    'results': results}, indent=2) + '\n')
print(json.dumps({'executed': len(results), 'expected_nonzero': len(results)}))

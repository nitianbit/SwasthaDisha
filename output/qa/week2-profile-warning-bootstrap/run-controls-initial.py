#!/usr/bin/env python3
"""Execute weakened owned fixture code against the same actual warning/budget unit."""
from pathlib import Path
import difflib
import hashlib
import json
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
QA = Path(__file__).resolve().parent
NODE = '/private/tmp/m0-node22/node'
ENV = {'PATH': '/usr/bin:/bin'}
TARGET = Path('/private/tmp/swasthadisha-parallel-p1qom53w/week2-profile-warning-scenario/test/api-runtime/scenario/scenario.cjs')
TARGET_SHA = 'cbb1260c887a7a5dc664fec9a6b47c680e1d180f78b102716122596baaae6500'
assert hashlib.sha256(TARGET.read_bytes()).hexdigest() == TARGET_SHA
source = (ROOT / 'test/api-runtime/scenario/bootstrap.cjs').read_text()
unit = (ROOT / 'test/api-runtime/scenario/bootstrap-unit.cjs').read_bytes()
ports = (ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_bytes()
message = "mongoose: the `new` option for `findOneAndUpdate()` and `findOneAndReplace()` is deprecated. Use `returnDocument: 'after'` instead."
attempt = 1
while (QA / f'controls-{attempt}').exists():
    attempt += 1
out = QA / f'controls-{attempt}'
out.mkdir()
variants = [
    ('MESSAGE_EQUALITY_REMOVED', [('message.value !== ' + json.dumps(message), "typeof message.value !== 'string'")], 'WARNING_UNKNOWN_BEFORE'),
    ('CODE_EQUALITY_REMOVED', [("code.value !== 'MONGOOSE'", 'false')], 'WARNING_UNKNOWN_WRONG_CODE'),
    ('EXTRA_OPTION_GUARD_REMOVED', [("keys.length !== 1 || keys[0] !== 'code'", 'false')], 'WARNING_UNKNOWN_EXTRA_OPTION'),
    ('CODE_GETTER_READ', [("const code = Object.getOwnPropertyDescriptor(options, 'code');", 'const code = { value: options.code };')], 'WARNING_UNKNOWN_OWN_ACCESSOR'),
    ('REFLECTION_FAILURE_PROMOTED', [('} catch { /* Every reflection failure stays unknown after total increment. */ }', '} catch { effects.mongooseNewAfterWarnings++; }')], 'WARNING_REFLECTION_FAILURE_getPrototypeOf'),
    ('TOTAL_CONSOLE_INCREMENT_REMOVED', [('  effects.console++;', '  /* weakened: total event omitted */')], 'WARNING_EXACT_CAPTURE_RETURN_UNDEFINED_AND_ONE_WRITE_BUDGET'),
    ('PRIVATE_CONFIG_EFFECT_EXEMPTED', [('const CONFIG_EFFECT_KEYS = Object.freeze(Object.keys(counters));', "const CONFIG_EFFECT_KEYS = Object.freeze(Object.keys(counters).filter(key => key !== 'mongooseNewAfterWarnings'));")], 'CONFIG_EXPECTED_FIXED_UNIT_FAILURE'),
    ('ACTUAL_EMIT_CLASSIFIER_BYPASSED', [('process.emitWarning = (...args) => recordCapturedWarning(args, counters);', 'process.emitWarning = () => { counters.console++; };')], 'WARNING_ACTUAL_EMIT_WRAPPER_NO_NATIVE_DELEGATE'),
    ('CONSOLE_METHOD_CLASSIFIED_AS_WARNING', [("for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = () => { counters.console++; };", "for (const name of ['log', 'info', 'debug', 'warn', 'error']) console[name] = (...args) => recordCapturedWarning(args, counters);")], 'WARNING_CONSOLE_METHOD_IS_UNKNOWN_log'),
    ('ARGUMENT_COUNT_GUARDS_REMOVED', [("argumentKeys.length !== 3 || ", ''), ("length.value !== 2", 'false')], 'WARNING_UNKNOWN_EXTRA_ARG'),
]
results = []
for name, transforms, marker in variants:
    changed = source
    for before, after in transforms:
        assert changed.count(before) == 1, name
        changed = changed.replace(before, after)
    (out / (name + '.patch')).write_text(''.join(difflib.unified_diff(source.splitlines(True), changed.splitlines(True),
                                                                   fromfile='nominal/bootstrap.cjs', tofile=name + '/bootstrap.cjs')))
    work = Path(tempfile.mkdtemp(prefix='owned-warning-control-', dir=out))
    identity = work.stat()
    shim = """'use strict';
const Module = require('node:module');
const fs = require('node:fs');
const crypto = require('node:crypto');
const owner = __OWNER__;
const target = __TARGET__;
if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== '__SHA__') throw new Error('WARNING_ACTUAL_SCENARIO_HASH');
const held = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './scenario.cjs' && parent && parent.filename === owner) return held.call(this, target, parent, isMain);
  return held.call(this, request, parent, isMain);
};
""".replace('__OWNER__', json.dumps(str(work / 'bootstrap-unit.cjs'))).replace('__TARGET__', json.dumps(str(TARGET))).replace('__SHA__', TARGET_SHA)
    bodies = {'bootstrap.cjs': changed.encode(), 'bootstrap-unit.cjs': unit, 'ports-manifest.json': ports, 'actual-fixture-seam.cjs': shim.encode()}
    for filename, body in bodies.items():
        with (work / filename).open('xb') as handle:
            handle.write(body)
    syntax = subprocess.run([NODE, '--check', str(work / 'bootstrap.cjs')], env=ENV, capture_output=True, timeout=25)
    assert syntax.returncode == 0, name + '_SYNTAX'
    command = [NODE, '--permission', '--allow-fs-read=' + str(work), '--allow-fs-read=' + str(TARGET),
               '--require', str(work / 'actual-fixture-seam.cjs'), str(work / 'bootstrap-unit.cjs')]
    result = subprocess.run(command, cwd=ROOT, env=ENV, capture_output=True, timeout=25)
    (out / (name + '.stdout')).write_bytes(result.stdout)
    (out / (name + '.stderr')).write_bytes(result.stderr)
    assert result.returncode != 0 and marker in (result.stdout + result.stderr).decode(), name + '_EXPECTED_REJECTION'
    results.append({'id': name, 'rejected': True, 'returncode': result.returncode, 'syntaxStatus': 'PASS',
                    'expectedFailureMarker': marker, 'transformations': transforms,
                    'sourceSha256': hashlib.sha256(changed.encode()).hexdigest(),
                    'unitSha256': hashlib.sha256(unit).hexdigest(), 'actualScenarioSha256': TARGET_SHA,
                    'seamSha256': hashlib.sha256(shim.encode()).hexdigest()})
    observed = work.stat()
    assert (identity.st_dev, identity.st_ino, identity.st_uid) == (observed.st_dev, observed.st_ino, observed.st_uid)
    assert set(path.name for path in work.iterdir()) == set(bodies)
    for filename, body in bodies.items():
        item = work / filename
        assert item.is_file() and not item.is_symlink() and item.stat().st_nlink == 1 and item.read_bytes() == body
        item.unlink()
    work.rmdir()
(out / 'result.json').write_text(json.dumps({'schema': 'SD-WARNING-BOOTSTRAP-WEAKENED-CONTROLS-1',
    'nominalSourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'actualOtherFixture': str(TARGET),
    'actualOtherFixtureSha256': TARGET_SHA, 'count': len(results), 'results': results,
    'applicationEvaluations': 0, 'compilerExecutions': 0, 'authority': 'BUILTINS_ONLY_FIXTURE_UNITS_NO_RUNTIME'}, indent=2) + '\n')
print(json.dumps({'status': 'PASS', 'controls': len(results), 'directory': str(out.relative_to(ROOT))}))

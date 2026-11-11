#!/usr/bin/env python3
"""Run only permissioned builtins-only fixture units against concrete weakened fixtures."""
from pathlib import Path
import difflib
import hashlib
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
QA = Path(__file__).resolve().parent
NODE = '/private/tmp/m0-node22/node'
ENV = {'PATH': '/usr/bin:/bin'}
source = (ROOT / 'test/api-runtime/scenario/bootstrap.cjs').read_text()
unit = (ROOT / 'test/api-runtime/scenario/bootstrap-unit.cjs').read_bytes()
ports = (ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_bytes()
attempt = 1
while (QA / f'controls-{attempt}').exists():
    attempt += 1
out = QA / f'controls-{attempt}'
out.mkdir()
variants = [
    ('POLICY_HASH_REMOVED', [
        ("need(sha(Buffer.from(text)) === PROFILE_POLICY_SHA, 'SPECIALIST_PROFILE_POLICY');", "need(true, 'SPECIALIST_PROFILE_POLICY');")],
     'PROFILE_ADMISSION_POLICY_TRIAL_CHANGED'),
    ('PARENT_SCOPE_REMOVED', [
        ('|| !parent || !parents.has(parent.filename)) return undefined;', '|| !parent) return undefined;')],
     'PROFILE_CHILD_OUTSIDE_DENIED_'),
    ('NATIVE_NODE_PREFIX_DENIAL_REMOVED', [
        ("need(!builtins.has(builtin) || !deniedBuiltins.has(builtin), 'DENIED_BUILTIN');", "need(true, 'DENIED_BUILTIN');")],
     'PROFILE_CHILD_OUTSIDE_DENIED_'),
    ('CLASS_UNKNOWN_MEMBER_LATCH_REMOVED', [
        ("if (key === 'constructor' || spec.methods.includes(key)) return Reflect.get(target, key, receiver);\n              return deny(name);", "if (key === 'constructor' || spec.methods.includes(key)) return Reflect.get(target, key, receiver);\n              return undefined;")],
     'PROFILE_CLASS_UNKNOWN_BookingRepository_unknownBusinessMethod'),
    ('CAUGHT_REGISTRATION_EFFECT_CHECK_REMOVED', [
        ("need(JSON.stringify(effects) === before && JSON.stringify(attempts) === beforeAttempts, 'SPECIALIST_PROFILE_REGISTRATION_EFFECT');", "need(true, 'SPECIALIST_PROFILE_REGISTRATION_EFFECT');")],
     'PROFILE_CAUGHT_REGISTRATION_CONSTRUCTOR_EFFECT_BookingRepository'),
    ('STATIC_ALIAS_AND_PATH_DENIAL_REMOVED', [
        ('staticPath(filename) { return staticPaths.has(filename); }', 'staticPath(filename) { return false; }'),
        ('staticAlias(alias) { return staticAliases.has(alias); }', 'staticAlias(alias) { return false; }')],
     'PROFILE_STATIC_DENIED_'),
    ('CALLER_MAP_SNAPSHOTS_REMOVED', [
        ('substitutes = Object.freeze({ ...nextSubstitutes }); overrides = Object.freeze({ ...nextOverrides });', 'substitutes = nextSubstitutes; overrides = nextOverrides;')],
     'PROFILE_PHASE_HOLDS_INDEPENDENT_SUBSTITUTE_AND_OVERRIDE_MAPS'),
    ('INDEX_CASE_END_BOUND_REMOVED', [('REQUIRED_CASE_IDS.slice(76, 83)', 'REQUIRED_CASE_IDS.slice(76)')],
     'PROFILE_BOUNDED_INDEX_CASE_AND_VARIANT_PREFIX'),
    ('INDEX_VARIANT_END_BOUND_REMOVED', [('REQUIRED_SENSITIVITY_IDS.slice(21, 27)', 'REQUIRED_SENSITIVITY_IDS.slice(21)')],
     'INDEX_SOURCE_BINDING'),
    ('PRELISTEN_CAUGHT_EFFECT_ASSERT_REMOVED', [("need(Object.values(attempts).every(value => value === 0) && effects.excluded === 0 && effects.unexpected === 0,", "need(true,")],
     'PROFILE_NO_LISTEN_AFTER_CAUGHT_CONSTRUCTOR_CAPABILITY'),
]
results = []
for name, transforms, expected in variants:
    changed = source
    for before, after in transforms:
        assert changed.count(before) == 1, name
        changed = changed.replace(before, after)
    (out / (name + '.patch')).write_text(''.join(difflib.unified_diff(source.splitlines(True), changed.splitlines(True),
                                                                  fromfile='nominal/bootstrap.cjs', tofile=name + '/bootstrap.cjs')))
    work = Path(tempfile.mkdtemp(prefix='owned-control-', dir=out))
    identity = work.stat()
    bodies = {'bootstrap.cjs': changed.encode(), 'bootstrap-unit.cjs': unit, 'ports-manifest.json': ports}
    for filename, body in bodies.items():
        with (work / filename).open('xb') as handle:
            handle.write(body)
    syntax = subprocess.run([NODE, '--check', str(work / 'bootstrap.cjs')], env=ENV, capture_output=True, timeout=25)
    assert syntax.returncode == 0, name + '_SYNTAX'
    command = [NODE, '--permission', '--allow-fs-read=' + str(work), str(work / 'bootstrap-unit.cjs')]
    result = subprocess.run(command, cwd=ROOT, env=ENV, capture_output=True, timeout=25)
    (out / (name + '.stdout')).write_bytes(result.stdout)
    (out / (name + '.stderr')).write_bytes(result.stderr)
    output = (result.stdout + result.stderr).decode()
    assert result.returncode != 0 and expected in output, name + '_EXPECTED_REJECTION'
    results.append({'id': name, 'returncode': result.returncode, 'rejected': True,
                    'expectedFailureMarker': expected, 'syntaxStatus': 'PASS', 'transformations': transforms,
                    'sourceSha256': hashlib.sha256(changed.encode()).hexdigest(),
                    'unitSha256': hashlib.sha256(unit).hexdigest(), 'portsSha256': hashlib.sha256(ports).hexdigest()})
    observed = work.stat()
    assert (identity.st_dev, identity.st_ino, identity.st_uid) == (observed.st_dev, observed.st_ino, observed.st_uid)
    assert set(path.name for path in work.iterdir()) == set(bodies)
    for filename, body in bodies.items():
        item = work / filename
        assert item.is_file() and not item.is_symlink() and item.stat().st_nlink == 1 and item.read_bytes() == body
        item.unlink()
    work.rmdir()
report = {'schema': 'SD-PROFILE-BOOTSTRAP-EXECUTABLE-CONTROLS-1', 'results': results, 'count': len(results),
          'nominalSourceSha256': hashlib.sha256(source.encode()).hexdigest(),
          'applicationEvaluations': 0, 'compilerEvaluations': 0,
          'authority': 'BUILTINS_ONLY_FIXTURE_WEAKENING_REJECTION_NOT_BUSINESS_RUNTIME'}
(out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'status': 'PASS', 'controls': len(results), 'directory': str(out.relative_to(ROOT))}))

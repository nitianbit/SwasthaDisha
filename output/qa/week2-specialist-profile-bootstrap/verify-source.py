#!/usr/bin/env python3
"""Source-data and scope checks only. No JS/TS/application execution."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = '1355bd9af2c9d8d5170527c8c0fc565de997b6fe'
QA = 'output/qa/week2-specialist-profile-bootstrap/'
OWNED = {'test/api-runtime/scenario/bootstrap.cjs', 'test/api-runtime/scenario/bootstrap-unit.cjs'}
checks = []


def require(value, label):
    if not value:
        raise AssertionError(label)
    checks.append(label)


def digest(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True)


ports = json.loads((ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_text())
inputs = json.loads((ROOT / 'output/qa/week2-specialist-profile-runtime/inputs.json').read_text())
section = ports['specialistProfile']
require(digest('test/api-runtime/scenario/ports-manifest.json') == '59c410ffc991fdcb4b1ee384f55ba896363011a207573c6f7abc7aa8763f948b', 'ROOT_PORTS_UNCHANGED')
require(hashlib.sha256(json.dumps(section, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        == '887792c1e2851fe3dfd37d93b3a1870da3adaed7fe41a4fd5e50bb62ea5c7212', 'CLOSED_PROFILE_POLICY')
require(digest('output/qa/week2-specialist-profile-runtime/CONTRACT.md') == inputs['contractSha256'], 'APPROVED_CONTRACT')
require(all(digest(path) == expected for path, expected in inputs['proposedClosure']['newSourceFiles'].items()), 'EIGHT_PRODUCTION_INPUTS_UNCHANGED')
require(all(digest(row['source']) == row['sourceSha256'] for row in section['staticAuditInputs']), 'FOUR_STATIC_SOURCES_UNCHANGED')

changed = set(git('diff', '--name-only', BASE, '--').splitlines())
untracked = set(git('ls-files', '--others', '--exclude-standard').splitlines())
require({path for path in changed if not path.startswith(QA)} == OWNED, 'EXACT_NON_QA_CHANGE_SET')
require(all(path.startswith(QA) for path in untracked), 'ONLY_OWN_QA_UNTRACKED')
for path in OWNED:
    item = ROOT / path
    require(item.is_file() and not item.is_symlink() and item.stat().st_nlink == 1
            and item.stat().st_mode & 0o777 == 0o644, 'REGULAR_644_' + item.name)
require(all(not item.is_symlink() and (item.is_dir() or (item.is_file() and item.stat().st_nlink == 1))
            for item in (ROOT / QA).rglob('*')), 'REGULAR_ONLY_OWN_QA')

source = (ROOT / 'test/api-runtime/scenario/bootstrap.cjs').read_text()
old = git('show', BASE + ':test/api-runtime/scenario/bootstrap.cjs')
unit = (ROOT / 'test/api-runtime/scenario/bootstrap-unit.cjs').read_text()
for left, right, name in [
    ('// Inert source contribution;', 'async function main()', 'ENTIRE_INDEX_MATRIX_AND_COLLECTION'),
    ('async function withOwnedCleanup(', 'function bytes(', 'OWNED_CLEANUP'),
    ('function closeNetwork(', 'function installLoader(', 'NETWORK_GUARDS'),
    ('function recordReadOperation(', '// Only private synthetic request copies', 'READ_OPERATION_COUNTER'),
]:
    require(source[source.index(left):source.index(right)] == old[old.index(left):old.index(right)], name + '_EXACT')
require('REQUIRED_CASE_IDS.slice(76, 83)' in source and 'REQUIRED_SENSITIVITY_IDS.slice(21, 27)' in source, 'OLD_INDEX_PREFIXES_BOUNDED')
require("app.use('/api/v1/specialists', authenticate, loader.load('@/modules/specialists/routes').default);" in source, 'REAL_ROUTER_AFTER_AUTHENTICATE')
require('get profileAttempts() { return loader.profileAttempts; }' in source, 'ONLY_NEW_CONTEXT_GETTER')
require('profileAdmission(manifest, plan, ports);' in source, 'PREIMPORT_PROFILE_BINDING')
require("app.use(loader.load('@/modules/middleware/errorHandler').errorHandler);\n    loader.assertProfileClean();\n    return new Promise" in source, 'CAUGHT_CONSTRUCTOR_EFFECT_STOPS_BEFORE_LISTEN')
require("profile.validatePhase(nextSubstitutes, nextOverrides);" in source, 'CLOSED_PHASE_BINDING')
require("need(!builtins.has(builtin) || !deniedBuiltins.has(builtin), 'DENIED_BUILTIN')" in source, 'NODE_COLON_FAST_PATH_DENIAL')
require("if (request.replace(/^node:/, '') === 'child_process') { nativeChildLoads++; throw" in unit, 'UNIT_NATIVE_CHILD_NEVER_LOADS')
require('PROFILE_CAUGHT_REGISTRATION_CONSTRUCTOR_EFFECT_' in unit and 'PROFILE_CLASS_UNKNOWN_' in unit, 'UNKNOWN_AND_CAUGHT_CONSTRUCTOR_CONTROLS')
require('PROFILE_PHASE_HOLDS_INDEPENDENT_SUBSTITUTE_AND_OVERRIDE_MAPS' in unit, 'CALLER_MAP_MUTATION_CONTROL')
require('PROFILE_STATIC_DENIED_' in unit and 'PROFILE_PARENT_CUT_' in unit, 'PATH_AND_PARENT_CONTROLS')

print(json.dumps({'schema': 'SD-PROFILE-BOOTSTRAP-SOURCE-CHECK-1', 'status': 'PASS', 'checks': checks,
                  'count': len(checks), 'applicationEvaluations': 0, 'compilerEvaluations': 0,
                  'authority': 'SOURCE_DATA_ONLY_NOT_RUNTIME_ACCEPTANCE'}, separators=(',', ':')))

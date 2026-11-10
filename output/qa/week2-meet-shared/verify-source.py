#!/usr/bin/env python3
"""Read only source-data preservation checks; never evaluate app or compiler."""
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
BASE = 'bac46d306a5f989c1eafcab5c40d4ce6fdd06e1d'
B = 'test/api-runtime/scenario/bootstrap.cjs'
U = 'test/api-runtime/scenario/bootstrap-unit.cjs'

def git(*args):
    return subprocess.check_output(['/usr/bin/git', *args], cwd=ROOT)

def baseline(name):
    return git('show', BASE + ':' + name).decode()

def section(text, first, last):
    return text[text.index(first):text.index(last, text.index(first))]

old_b, old_u = baseline(B), baseline(U)
new_b, new_u = (ROOT / B).read_text(), (ROOT / U).read_text()
assert hashlib.sha256(old_b.encode()).hexdigest() == '669b47f1cf3bdf7b84e1dce26f2255d1df36b2861b6a0bb1b8984e63a9273418'
assert hashlib.sha256(old_u.encode()).hexdigest() == 'e2d0346af2608fa85cc6b51fc596d807e6e3102cb35065a392ec210162ca2d67'
assert section(old_b, 'const MODEL_IDENTITIES =', '\nconst sha =') == section(new_b, 'const MODEL_IDENTITIES =', '\nconst sha =')
for first, last in [
    ('const SETUP_FAILURE_CODES =', '\nfunction bytes('),
    ('function closeNetwork()', '// Safe telemetry'),
    ('function recordReadOperation(', '// Fixed synthetic settings'),
    ('function recordingPorts(', '// This controller'),
]:
    old_last = 'function recordingPorts(' if last == '// Fixed synthetic settings' else last
    assert section(old_b, first, old_last) == section(new_b, first, last), first
assert section(old_b, 'const CONFIG_ALIAS =', 'async function main()').replace(
    'REQUIRED_SENSITIVITY_IDS.slice(14)', 'REQUIRED_SENSITIVITY_IDS.slice(14, 17)'
) == section(new_b, 'const CONFIG_ALIAS =', 'async function main()')
assert section(old_b, 'async function main()', '  Object.assign(process.env,') == section(new_b, 'async function main()', '  Object.assign(process.env,')
assert section(old_b, '  const originalConnect =', '  let currentPorts; let server;') == section(new_b, '  const originalConnect =', '  const meetLifecycle =')
# Inverse only the explicit fixture plumbing and appended tests. The residual
# must equal every byte of the historical267-case unit source.
residual = new_u
residual = residual.replace('\nglobalThis.fetch = blockedNetwork;', '')
residual = residual.replace('  configurationSampleEvidence, collectConfigurationEvidence, meetData, meetSame, createMeetRecorder,\n  meetFetchLifecycle, withMeetFetchCleanup } = require(bootstrap);', '  configurationSampleEvidence, collectConfigurationEvidence } = require(bootstrap);')
residual = residual.replace("\n  for (const name of ['routes', 'controller', 'validation', 'service', 'types']) sources['src1/modules/meet/' + name + '/index.ts'] = 'a'.repeat(64);", '')
residual = residual.replace(" : name.startsWith('MEET_') ? 'src1/modules/meet/routes/index.ts'", '')
residual = residual.replace("\n  plan.modules['@/modules/meet/routes'] = 'compiled/modules/meet/routes/index.js'; files['compiled/modules/meet/routes/index.js'] = Buffer.from('inert');", '')
residual = residual.replace("'dbWrites', 'calendar'", "'dbWrites'")
residual = residual.replace('portsOriginal.requiredSensitivityIds.slice(14, 17)', 'portsOriginal.requiredSensitivityIds.slice(14)')
start = residual.index("for (const [id, mutate] of [\n  ['MISSING_MAP'")
end = residual.index('const recordingRows = [];', start)
residual = residual[:start] + residual[end:]
residual = residual.replace('\nconst meetRows = [];', '')
start = residual.index('async function meetUnits() {')
end = residual.index('async function setupUnits() {', start)
residual = residual[:start] + residual[end:]
residual = residual.replace(' + configurationRows.length + meetRows.length, recordingCases:', ' + configurationRows.length, recordingCases:')
residual = residual.replace('\n    meetRecorderCases: meetRows.length,', '')
residual = residual.replace('meetUnits().then(setupUnits).catch(() => {', 'setupUnits().catch(() => {')
assert residual == old_u, 'Historical267-case unit bodies changed outside enumerated plumbing'
all_changed = git('diff', '--no-renames', '--name-only', BASE).decode().splitlines()
changed = [name for name in all_changed if not name.startswith(('output/qa/week2-meet-runtime/', 'output/qa/week2-meet-shared/'))
    and name != 'test/api-runtime/scenario/ports-manifest.json']
assert set(changed) == {B, U}, changed
assert all(name.startswith('output/qa/week2-meet-shared/') for name in git('ls-files', '--others', '--exclude-standard').decode().splitlines())
for name in changed:
    assert (ROOT / name).stat().st_mode & 0o777 == 0o644
pins = json.loads((ROOT / 'output/qa/week2-meet-runtime/baseline-freeze.json').read_bytes())['baselinePins']
for name, digest in pins.items():
    if name not in {B, U, 'test/api-runtime/scenario/ports-manifest.json'}:
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
assert hashlib.sha256((ROOT / 'test/api-runtime/scenario/ports-manifest.json').read_bytes()).hexdigest() == '86d6b909c06387c52c8d62e3b99a10784d9612fb6fc63581faf6d3e96ee13a12'
print(json.dumps({'status': 'SOURCE_DATA_PRESERVATION_PASS', 'baseline': BASE,
    'historicalPureCases': 267, 'historicalUnitResidualByteIdentical': True,
    'historicalConfigurationControllerByteIdenticalExceptSlice14To17': True,
    'modelsNetworkLoaderRecordingDatabaseSetupUnchanged': True,
    'changedTrackedFiles': changed, 'applicationEvaluations': 0,
    'configurationEvaluations': 0, 'compilerExecutions': 0, 'DockerCalls': 0}))

#!/usr/bin/env python3
"""Temporarily weaken OWNED fixture source only, run exact pure unit, restore bytes.
No application/package code or resources. Parent writes owned evidence; Node has
only the pre-existing read grant, no write/child/worker/addon permissions.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[3]
QA = Path(__file__).resolve().parent
SOURCE = ROOT / 'test/api-runtime/scenario/bootstrap.cjs'
UNIT = ROOT / 'test/api-runtime/scenario/bootstrap-unit.cjs'
NODE = Path('/private/tmp/m0-node22/node')
sha = lambda data: hashlib.sha256(data).hexdigest()
assert sha(NODE.read_bytes()) == '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0'
nominal = SOURCE.read_bytes(); text = nominal.decode()
assert sha(nominal) == 'd4f0c8dfd5270ef848e21e9b215f05d59b12c8da3aeffcb2d833fc924c76afe1'
assert sha(UNIT.read_bytes()) == '5e07b774142608676d6a3aa81b0d58b74fce71022538e46e9d103c4cc639ca84'
metadata = SOURCE.lstat(); assert SOURCE.is_file() and not SOURCE.is_symlink() and metadata.st_nlink == 1
controls = [
 ('MISSING_FINALLY_CLOSURE', 'try { reset(); } finally { containerResetWindow = false; }', 'try { reset(); } finally {}', 'PROFILE_RESET_WINDOW_OUTSIDE_DENIED_BookingRepository'),
 ('PERMANENT_DESTROY_EXCEPTION', "if (containerResetWindow && key === 'destroy') return undefined;", "if (key === 'destroy') return undefined;", 'PROFILE_RESET_WINDOW_OUTSIDE_DENIED_BookingRepository'),
 ('BROAD_UNKNOWN_EXEMPTION', "if (containerResetWindow && key === 'destroy') return undefined;", "if (containerResetWindow && key !== 'constructor' && !spec.methods.includes(key)) return undefined;", 'PROFILE_RESET_WINDOW_UNKNOWN_DENIALS_BookingRepository'),
 ('BUSINESS_METHOD_BYPASS_INSIDE_WINDOW', "if (containerResetWindow && key === 'destroy') return undefined;", "if (containerResetWindow && key === 'destroy') return undefined;\n              if (containerResetWindow && spec.methods.includes(key)) return () => undefined;", 'PROFILE_RESET_WINDOW_BUSINESS_DENIALS_BookingRepository'),
 ('CAUGHT_FORBIDDEN_LATCHES_CLEARED', "if (containerResetWindow && key === 'destroy') return undefined;", "if (containerResetWindow && key === 'destroy') { effects.excluded = 0; effects.unexpected = 0; attempts[name] = 0; return undefined; }", 'PROFILE_RESET_WINDOW_OUTSIDE_DENIED_BookingRepository'),
]
command = [str(NODE), '--permission', '--allow-fs-read=' + str(ROOT / 'test/api-runtime/scenario'), 'test/api-runtime/scenario/bootstrap-unit.cjs']
records = []
try:
    for identity, before, after, expected_case in controls:
        assert text.count(before) == 1, identity
        changed = text.replace(before, after).encode()
        folder = QA / 'weakening-controls' / identity
        folder.mkdir(parents=True, exist_ok=False)
        (folder / 'bootstrap.cjs').write_bytes(changed)
        SOURCE.write_bytes(changed)
        with (folder / 'unit.json').open('wb') as out, (folder / 'unit.stderr.txt').open('wb') as err:
            result = subprocess.run(command, cwd=ROOT, env={'PATH': '/usr/bin:/bin'}, stdout=out, stderr=err, timeout=60)
        payload = json.loads((folder / 'unit.json').read_text())
        record = {'id': identity, 'sourceSha256': sha(changed), 'before': before, 'after': after,
                  'command': command, 'environment': {'PATH': '/usr/bin:/bin'}, 'exitCode': result.returncode,
                  'result': payload, 'requiredFixedCase': expected_case,
                  'rejected': result.returncode == 1 and payload.get('failed') == 1
                    and payload.get('code') == 'OFFLINE_SETUP_UNIT_FAILED' and payload.get('profileCase') == expected_case}
        records.append(record)
        (folder / 'control.json').write_text(json.dumps(record, indent=2) + '\n')
finally:
    SOURCE.write_bytes(nominal)
    assert SOURCE.read_bytes() == nominal and SOURCE.stat().st_ino == metadata.st_ino and SOURCE.stat().st_nlink == 1
report = {'schema': 'SD-PROFILE-LIFECYCLE-WEAKENING-CONTROLS-1', 'nominalSourceSha256': sha(nominal),
          'unitSha256': sha(UNIT.read_bytes()), 'controls': records, 'restoredExactNominal': SOURCE.read_bytes() == nominal,
          'status': 'PASS' if len(records) == 5 and all(record['rejected'] for record in records) else 'FAIL',
          'limits': 'Actual fixture classes and pure fake ports only; exact baseline unit read/permission recipe; no app/package/TypeDI/compiler/DB/provider/nativechild execution. Failures bound to fixed newly added cases, not arbitrary nonzero exit.'}
(QA / 'weakening-controls.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'status': report['status'], 'controlsRejected': sum(row['rejected'] for row in records), 'restoredExactNominal': report['restoredExactNominal']}))
sys.exit(0 if report['status'] == 'PASS' else 1)

"""Four owned pure/fake source variants. No app/native-client/model execution."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = Path('/private/tmp/swasthadisha-parallel-p1qom53w/claude-review-window')
OWNED = ROOT / 'output/qa/week2-local-review-link/review-window-2'
source = (ROOT / 'tools/agents/claude-ruflo-review.py').read_text()
tests = (ROOT / 'tools/agents/claude-ruflo-review.test.py').read_bytes()
changes = [
    ('RESTORE_1200_DEADLINE', 'REVIEW_SECONDS = 3600', 'REVIEW_SECONDS = 1200'),
    ('SHORTEN_EOF_GRACE', 'EOF_SECONDS = 9', 'EOF_SECONDS = 8'),
    ('ALLOW_REMOTE_ONLY_EFFORT_ON_LOCAL_PRINT',
        "need(event.get('effort') is None, 'CLIENT_INIT_UNSUPPORTED')", 'need(True, \'CLIENT_INIT_UNSUPPORTED\')'),
    ('SELF_CERTIFY_EFFECTIVE_MAX', "'effectiveEffort': 'UNPROVEN'", "'effectiveEffort': 'max'"),
]
results = []
for name, old, new in changes:
    assert old in source
    with tempfile.TemporaryDirectory(prefix='sd-claude-review-fake-control-') as temp:
        directory = Path(temp)
        (directory / 'claude-ruflo-review.py').write_text(source.replace(old, new))
        entry = directory / 'claude-ruflo-review.test.py'; entry.write_bytes(tests)
        run = subprocess.run([sys.executable, '-I', '-B', str(entry)], cwd=directory,
            env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}, stdin=subprocess.DEVNULL,
            capture_output=True, timeout=15)
        assert run.returncode != 0 and len(run.stdout) + len(run.stderr) < 1024 * 1024
        output = run.stdout + run.stderr
        assert b'FAILED (failures=' in output and b'REAL_EFFECT_PORT_DISABLED' not in output
        failing = re.findall(rb'^FAIL: (test_[a-z0-9_]+)', output, re.MULTILINE)
        assert failing
        results.append({'id': name, 'detected': True, 'exit': run.returncode,
            'failedCases': [v.decode() for v in failing],
            'outputSha256': hashlib.sha256(output).hexdigest()})
    assert not directory.exists()
record = {'schema': 'SD-CLAUDE-WINDOW-NEGATIVE-CONTROLS-2',
    'controls': results, 'required': 4, 'detected': 4,
    'modelRequests': 0, 'nativeClientRequests': 0, 'appEvaluations': 0,
    'allOwnedTemporaryDirectoriesRemoved': True}
(OWNED / 'negative-controls.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record))

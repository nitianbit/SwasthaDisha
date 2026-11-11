"""Read/hash/AST-only verification; no app imports, native CLI or model calls."""
from pathlib import Path
import ast
import hashlib
import json
import os
import stat
import subprocess

ROOT = Path('/private/tmp/swasthadisha-parallel-p1qom53w/claude-review-window')
QA = ROOT / 'output/qa/week2-local-review-link'
OWNED = QA / 'review-window-2'
SOURCE = Path('/private/tmp/swasthadisha-parallel-p1qom53w/api-runtime-preparation-9')
SOURCE_SHA = 'c2dbac3e44b0bbf30e4574640cd940e2f0075975'
EVIDENCE_SHA = '638f44dea50fca667e4cf2accfb2f6c82b5e9cd5'
DESCRIPTOR_SHA = '185fb708ef0af3b4bbf106b836baee69d20b922a6089b418e42ed739f6e801e7'

def sha(body): return hashlib.sha256(body).hexdigest()
def read(path):
    p = Path(path); s = p.lstat()
    assert stat.S_ISREG(s.st_mode) and s.st_nlink == 1
    return p.read_bytes()
def git(*args, cwd):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c',
        'core.fsmonitor=false', *args], cwd=cwd, env={'PATH': '/usr/bin:/bin'}, timeout=10)

candidate_bytes = read(QA / 'claude-review-invocation.json')
manifest_bytes = read(QA / 'claude-review-input-manifest.json')
c, m = json.loads(candidate_bytes), json.loads(manifest_bytes)
assert c['sourceCommit'] == m['sourceCommit'] == SOURCE_SHA
assert c['evidenceCommit'] == m['evidenceCommit'] == EVIDENCE_SHA
assert m['descriptorSha256'] == DESCRIPTOR_SHA
assert c['timeoutSeconds'] == 3600 and c['maxTurns'] == 8
assert c['argv'][c['argv'].index('--max-turns') + 1] == '8'
assert c['argv'][c['argv'].index('--effort') + 1] == 'max'
assert c['argv'][c['argv'].index('--mcp-config') + 1] == str(QA / 'claude-review-mcp.json')
assert c['argv'][-2:] == ['--session-id', c['sessionId']]
assert c['inputManifestSha256'] == sha(manifest_bytes)
assert sha(read(QA / 'claude-review-mcp.json')) == c['mcpConfigSha256'] == m['mcpConfigSha256']
assert sha(read(QA / 'CLAUDE_CLI_REVIEW_PROMPT.md')) == m['promptSha256']
payload = read(c['stdinFile'])
assert len(payload) == c['stdinBytes'] == m['inputBytes'] < 2 * 1024 * 1024
assert sha(payload) == c['stdinSha256'] == m['inputSha256']
assert stat.S_IMODE(Path(c['stdinFile']).stat().st_mode) == 0o600
assert stat.S_IMODE(Path(c['stdinFile']).parent.stat().st_mode) == 0o700
assert stat.S_IMODE(Path(c['privateOutputDirectory']).stat().st_mode) == 0o700
assert not any(Path(c['privateOutputDirectory']).iterdir())
snapshot = json.loads(payload)
assert snapshot['sourceCommit'] == SOURCE_SHA and snapshot['evidenceCommit'] == EVIDENCE_SHA
assert sha(snapshot['instruction'].encode()) == m['promptSha256']
assert len(snapshot['files']) == m['fileCount'] == 141
assert len({f['path'] for f in snapshot['files']}) == 141
assert [{k: v for k, v in f.items() if k != 'content'} for f in snapshot['files']] == m['files']
descriptor = read(SOURCE / 'test/api-runtime/scenario/runtime-template.json')
assert sha(descriptor) == DESCRIPTOR_SHA
d = json.loads(descriptor)
assert len(d['sourceFiles']) == 96 and len(d['files']) == 2870
assert git('rev-parse', 'HEAD', cwd=SOURCE).decode().strip() == SOURCE_SHA
assert git('status', '--porcelain', cwd=SOURCE) == b''
for f in snapshot['files']:
    body = f['content'].encode(); assert sha(body) == f['sha256']
    if f['kind'] == 'DESCRIPTOR_SUMMARY':
        s = json.loads(body)
        assert s['descriptorSha256'] == DESCRIPTOR_SHA and s['sourceFiles'] == d['sourceFiles']
        assert s['runtimeFileCount'] == 2870
        assert s['runtimeFileManifestSha256'] == sha(json.dumps(d['files'], sort_keys=True).encode())
        continue
    assert read(f['path']) == body
    if f['kind'] in ['FROZEN_SOURCE', 'FROZEN_REVIEW_CONTEXT']:
        relative = str(Path(f['path']).relative_to(SOURCE))
        assert body == git('show', SOURCE_SHA + ':' + relative, cwd=SOURCE)
    if f['kind'] in ['ACTUAL_RUN_EVIDENCE', 'PREPARATION_EVIDENCE', 'FAILED_ATTEMPT_HISTORY', 'ACTUAL_RUN_CONTEXT']:
        relative = str(Path(f['path']).relative_to(ROOT))
        assert body == git('show', EVIDENCE_SHA + ':' + relative, cwd=ROOT)
archive = json.loads(read(OWNED / 'prior/archive-manifest.json'))
for name, expected in archive['files'].items():
    assert sha(read(OWNED / 'prior' / name)) == expected
assert sha(read(archive['privateInputArchive'])) == archive['privateInputSha256']
assert sha(read(archive['privateInputOriginal'])) == archive['privateInputSha256']
operator_text = read(ROOT / 'tools/agents/claude-ruflo-review.py').decode()
assignments = {}
for node in ast.parse(operator_text).body:
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
        try: assignments[node.targets[0].id] = ast.literal_eval(node.value)
        except (ValueError, TypeError): pass
assert assignments['REVIEW_SECONDS'] == 3600 and assignments['EOF_SECONDS'] == 9
assert assignments['MAX_TURNS'] == 8 and assignments['SNAPSHOT_FILE_COUNT'] == 141
assert assignments['REVIEW_SOURCE'] == SOURCE_SHA and assignments['REVIEW_EVIDENCE'] == EVIDENCE_SHA
assert assignments['REVIEW_TEMPLATE'] == DESCRIPTOR_SHA
assert assignments['CANDIDATE_SHA'] == sha(candidate_bytes) and assignments['MANIFEST_SHA'] == sha(manifest_bytes)
assert assignments['AMENDMENT_SHA'] == sha(read(OWNED / 'AMENDMENT_CONTRACT.md'))
ast.parse(read(ROOT / 'tools/agents/claude-ruflo-review.test.py'))
main = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha')
preserved = json.loads(read(main / 'output/qa/m0-b/otp-containment-2026-11-10/source-verification.json'))
for name, expected in preserved['preserved_handover_sha256'].items():
    assert sha(read(main / name)) == expected
handover = main / 'documentation/planning/implementation/handover/2026-11-10-local-extensions'
frozen = json.loads(read(handover / 'review-input.json'))
for name, expected in frozen['files_sha256'].items():
    assert sha(read(main / name)) == expected
assert sha(git('diff', '--no-ext-diff', '--no-textconv', '--cached', '--binary', '--full-index', cwd=main)) == preserved['staged_patch_sha256']
result = {'schema': 'SD-CLAUDE-REVIEW-WINDOW-VERIFICATION-2',
    'sourceCommit': SOURCE_SHA, 'evidenceCommit': EVIDENCE_SHA,
    'candidateSha256': sha(candidate_bytes), 'inputManifestSha256': sha(manifest_bytes),
    'bodyHashesVerified': 141, 'descriptorInputs': 96, 'priorPublicHashesVerified': len(archive['files']),
    'priorPrivateOriginalAndArchiveUnchanged': True, 'originalStagedFiles': 6,
    'originalHandoverFiles': 11, 'originalStagedPatchUnchanged': True,
    'syntaxChecks': 2, 'modelRequests': 0, 'authStatusRequests': 0,
    'appEvaluations': 0, 'DockerCalls': 0,
    'contextAdmission': 'UNRESOLVED_EXACT_TOKENS_AND_EFFECTIVE_SESSION_WINDOW_NOT_MEASURED',
    'effectiveEffort': 'UNPROVEN', 'actualClaudeExtensionACK': False}
(OWNED / 'packet-verification.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))

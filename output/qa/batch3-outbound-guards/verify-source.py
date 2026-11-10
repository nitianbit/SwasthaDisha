"""Read-only source transformation checks; never evaluate TypeScript or an app."""
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = 'eba7e5c82e3ff63af9e9a958fbd100733e1fc439'
EVIDENCE = 'output/qa/batch3-outbound-guards/'
NOTIFY = 'src1/modules/notification/routes/index.ts'
MEET = 'src1/modules/meet/routes/index.ts'
FROZEN = {
    NOTIFY: '2635aa42a2b67d4b349a2fa4162d538cb60225e0b6d01a2598792124a8a7f6e3',
    MEET: '27ab67d1dad1bef4bd2a92c8b29f8b2b6621252bb535694e359c952b9a5fa81c',
    'src1/modules/middleware/auth.ts': 'db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2',
    'src1/routes/index.ts': '50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056',
    'src1/modules/notification/services/index.ts': 'dd343357282c5c80fb02da2913d9eaf1ec772e7df0daa39f9a4b0bfc87c9311d',
    'src1/modules/meet/controller/index.ts': '94b5d080c86ed8b9bb0f1ba4a145ed67d9e51115bbb10e26013a30026bf7aff0',
}
CONTRACT_SHA = '83022403da91bd374a976c984e89303cceea80ed6e30c30c6f777fc19dcd98b2'


def sha(b):
    return hashlib.sha256(b).hexdigest()


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def replace_once(text, old, new):
    assert text.count(old) == 1, 'Unexpected baseline replacement count'
    return text.replace(old, new, 1)


def expected_sources():
    source = {}
    for path, digest in FROZEN.items():
        data = git('show', BASE + ':' + path)
        assert sha(data) == digest, 'Baseline hash differs: ' + path
        source[path] = data.decode()
    notification = replace_once(source[NOTIFY],
        "import { requireSpecialist } from '@/modules/middleware/auth';",
        "import { requireAdmin, requireSpecialist } from '@/modules/middleware/auth';")
    for route in ['/', '/send']:
        notification = replace_once(notification,
            "notificationRouter.post(\n  '" + route + "',\n",
            "notificationRouter.post(\n  '" + route + "',\n  requireAdmin,\n")
    meeting = replace_once(source[MEET],
        "// import { authenticate, requireAdmin } from '@/modules/middleware/auth';",
        "import { authenticate, requireAdmin } from '@/modules/middleware/auth';")
    for method, route in [('get', '/google-oauth/url'), ('post', '/google-oauth/exchange'),
                          ('post', '/google-oauth/refresh'), ('post', '/google-meet/oauth')]:
        prefix = "meetRouter." + method + "(\n  '" + route + "',\n"
        meeting = replace_once(meeting, prefix, prefix + '  authenticate,\n  requireAdmin,\n')
    return {NOTIFY: notification.encode(), MEET: meeting.encode()}


def verify_bytes(actual, expected):
    assert set(actual) == set(expected), 'Production file set differs'
    for path in expected:
        assert actual[path] == expected[path], 'Exact reviewed route transformation differs: ' + path


def controls(expected):
    mutants = []
    for path, router, method, route in [
        (NOTIFY, 'notificationRouter', 'post', '/'),
        (NOTIFY, 'notificationRouter', 'post', '/send'),
        (MEET, 'meetRouter', 'get', '/google-oauth/url'),
        (MEET, 'meetRouter', 'post', '/google-oauth/exchange'),
        (MEET, 'meetRouter', 'post', '/google-oauth/refresh'),
        (MEET, 'meetRouter', 'post', '/google-meet/oauth'),
    ]:
        text = expected[path].decode()
        prefix = router + '.' + method + "(\n  '" + route + "',\n"
        block = re.search(re.escape(prefix) + r'.*?\n\);', text, re.S).group()
        edits = [('missing-admin', block.replace('  requireAdmin,\n', '', 1)),
                 ('weakened-admin', block.replace('  requireAdmin,\n', '  requireSpecialist,\n', 1))]
        if path == MEET:
            edits.extend([
                ('missing-authenticate', block.replace('  authenticate,\n', '', 1)),
                ('admin-before-authenticate', block.replace('  authenticate,\n  requireAdmin,\n',
                                                         '  requireAdmin,\n  authenticate,\n', 1)),
            ])
        else:
            validation = next(line for line in block.splitlines(True) if '  validate(' in line)
            edits.append(('late-admin', block.replace('  requireAdmin,\n', '', 1).replace(
                validation, validation + '  requireAdmin,\n', 1)))
        for label, changed in edits:
            mutant = dict(expected)
            mutant[path] = replace_once(text, block, changed).encode()
            mutants.append((router + ':' + route + ':' + label, mutant))
    for label, path, old, new in [
        ('gated-callback', MEET, "  '/google-oauth/callback',\n", "  '/google-oauth/callback',\n  authenticate,\n  requireAdmin,\n"),
        ('missing-meet-import', MEET, "import { authenticate, requireAdmin }", "// import { authenticate, requireAdmin }"),
        ('missing-notification-import', NOTIFY, 'import { requireAdmin, requireSpecialist }', 'import { requireSpecialist }'),
    ]:
        mutant = dict(expected)
        mutant[path] = replace_once(expected[path].decode(), old, new).encode()
        mutants.append((label, mutant))
    results = []
    for label, mutant in mutants:
        try:
            verify_bytes(mutant, expected)
        except AssertionError:
            results.append({'control': label, 'result': 'REJECTED_AS_EXPECTED'})
        else:
            raise AssertionError('Source control survived: ' + label)
    return results


def verify():
    expected = expected_sources()
    assert sha((ROOT / EVIDENCE / 'CONTRACT.md').read_bytes()) == CONTRACT_SHA
    for path in FROZEN.keys() - expected.keys():
        assert sha((ROOT / path).read_bytes()) == FROZEN[path], 'Frozen input changed: ' + path
    baseline = {p: git('show', BASE + ':' + p) for p in expected}
    try:
        verify_bytes(baseline, expected)
    except AssertionError:
        baseline_result = 'REJECTED_AS_EXPECTED'
    else:
        raise AssertionError('Unprotected baseline unexpectedly accepted')
    actual = {}
    for path in expected:
        p = ROOT / path
        mode = p.lstat().st_mode
        assert stat.S_ISREG(mode) and not mode & 0o111, 'Source is not a regular non-executable file'
        actual[path] = p.read_bytes()
    verify_bytes(actual, expected)
    changed = git('diff', '--no-renames', '--name-only', BASE, '--').decode().splitlines()
    untracked = git('ls-files', '--others').decode().splitlines()
    for path in changed + untracked:
        assert path in expected or path.startswith(EVIDENCE), 'Outside bounded scope: ' + path
    return {
        'status': 'SOURCE_TRANSFORMATION_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASE,
        'baseline_rejection': baseline_result, 'source_negative_controls': controls(expected),
        'production_sha256': {p: sha(b) for p, b in actual.items()},
        'contract_sha256': CONTRACT_SHA, 'verifier_sha256': sha(Path(__file__).read_bytes()),
        'TypeScript_evaluations': 0, 'application_DB_provider_Docker_calls': 0,
        'runtime_cases': 'NOT_RUN_PENDING_COMPLETE_C3',
    }


if __name__ == '__main__':
    print(json.dumps(verify(), indent=2))

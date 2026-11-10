"""Verify the own-recipient amendment as source data, never as TypeScript."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = 'bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7'
SOURCE = 'src1/modules/notification/controller/index.ts'
METHODS = ('getByUserId', 'getUnreadByUserId', 'getUnreadCount', 'markAllAsRead')
GUARD = '    this.assertOwnRecipient(req, userId);\n'
HELPER = '''  private assertOwnRecipient(req: AuthRequest, userId: string): void {
    if (!req.user?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user._id !== userId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to another recipient is not permitted',
      });
    }
  }

'''


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def expected_source():
    original = git('show', BASELINE + ':' + SOURCE).decode()
    assert hashlib.sha256(original.encode()).hexdigest() == '9734a2cb0974c9d1b173b00eb41ef352878a187baba5f6792202bac4baab4755'
    expected = original.replace("import { AuthRequest } from '@/modules/middleware/auth';\n", "import { AuthRequest } from '@/modules/middleware/auth';\nimport { AppError } from '@/modules/common/types';\n")
    expected = expected.replace('  create = async ', HELPER + '  create = async ', 1)
    for name in METHODS:
        marker = '  ' + name + ' = async '
        start = expected.index(marker)
        end = expected.index('\n  };', start) + len('\n  };')
        method = expected[start:end]
        assert method.count('req: Request') == 1 and method.count('    const { userId } = req.params;\n') == 1
        amended = method.replace('req: Request', 'req: AuthRequest', 1)
        amended = amended.replace('    const { userId } = req.params;\n', '    const { userId } = req.params;\n' + GUARD, 1)
        expected = expected[:start] + amended + expected[end:]
    return original, expected


def check(candidate, expected):
    assert HELPER in candidate, 'Missing or changed own-recipient authority guard'
    for name in METHODS:
        start = candidate.index('  ' + name + ' = async ')
        end = candidate.index('\n  };', start)
        method = candidate[start:end]
        assert 'req: AuthRequest' in method, 'Authenticated request annotation missing: ' + name
        assert method.count(GUARD) == 1, 'Recipient guard missing: ' + name
        assert method.index(GUARD) < method.index('this.notificationService.'), 'Recipient guard is after service access: ' + name
    assert candidate == expected, 'Unexpected controller change beyond the reviewed amendment'


def verify(negative_controls):
    original, expected = expected_source()
    if negative_controls:
        cases = [('original_unguarded_controller', original)]
        for name in METHODS:
            start = expected.index('  ' + name + ' = async ')
            end = expected.index('\n  };', start)
            method = expected[start:end]
            missing = method.replace(GUARD, '', 1)
            late = method.replace(GUARD, '', 1).replace('\n    res.status(', '\n' + GUARD + '    res.status(', 1)
            cases.extend([(name + '_guard_removed', expected[:start] + missing + expected[end:]),
                          (name + '_guard_after_service', expected[:start] + late + expected[end:])])
        cases.extend([
            ('inverted_recipient_comparison', expected.replace('req.user._id !== userId', 'req.user._id === userId')),
            ('missing_identity_guard', expected.replace('if (!req.user?._id)', 'if (false)')),
            ('admin_cross_recipient_bypass', expected.replace('    if (req.user._id !== userId)', "    if (req.user.userType === 'admin') return;\n    if (req.user._id !== userId)")),
        ])
        rejected = []
        for name, candidate in cases:
            try:
                check(candidate, expected)
            except AssertionError:
                rejected.append(name)
            else:
                raise AssertionError('Source negative accepted: ' + name)
        return {'status': 'SOURCE_NEGATIVES_REJECTED', 'controls': rejected, 'typescript_evaluations': 0}
    check((ROOT / SOURCE).read_text(), expected)
    protected = ['src1/modules/notification/routes/index.ts', 'src1/modules/notification/services/index.ts',
                 'src1/modules/notification/repository/index.ts', 'src1/modules/notification/types/index.ts',
                 'src1/modules/notification/model/index.ts', 'src1/modules/fcm/controller/index.ts']
    for path in protected:
        assert (ROOT / path).read_bytes() == git('show', BASELINE + ':' + path), 'Protected source changed: ' + path
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'source_sha256': hashlib.sha256(expected.encode()).hexdigest(), 'guarded_handlers': list(METHODS),
            'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--negative-controls', action='store_true')
    options = parser.parse_args()
    try:
        print(json.dumps(verify(options.negative_controls)))
    except AssertionError as failure:
        print(json.dumps({'status': 'REJECTED', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(1)

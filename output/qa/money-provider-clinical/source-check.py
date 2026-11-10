"""Verify the wallet authority amendment as source data, never as TypeScript.

Reads TypeScript files as text only. Nothing is imported, compiled or evaluated.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d'
ROUTES = 'src1/modules/wallet/routes/index.ts'
AUTH = 'src1/modules/middleware/auth.ts'
ROUTES_BASELINE_SHA256 = '18261ce7a70a8e870d5cabbb675732aa0a424800fe44986ddbec0ec653c83f85'
AUTH_BASELINE_SHA256 = 'db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2'
PINNED = (
    'src1/modules/common/middleware/validation.ts',
    'src1/modules/middleware/errorHandler.ts',
    'src1/modules/middleware/index.ts',
    AUTH,
    'src1/config/config.ts',
)
ADMIN_GUARD = 'requireAdmin'
OWN_GUARD = 'requireOwnWalletOrAdmin'
ADMIN_ROUTES = (('post', '/'), ('post', '/transactions'), ('put', '/:id'), ('get', '/'))
OWN_ROUTES = (('get', '/user/:userId'), ('get', '/user/:userId/transactions'))
OLD_EXPRESS_IMPORT = "import { Router } from 'express';\n"
VALIDATE_IMPORT = "import { validate } from '@/modules/common/middleware/validation';\n"
IMPORT_LINES = (
    "import { NextFunction, Response, Router } from 'express';\n",
    "import { AppError } from '@/modules/common/types';\n",
    "import { AuthRequest, requireAdmin } from '@/modules/middleware/auth';\n",
)
HELPER_ANCHOR = 'const walletController = new WalletController();\n\n'
HELPER_DECL = 'const requireOwnWalletOrAdmin = (\n'
IDENTITY_BLOCK = '''    if (!req.user?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
'''
CONDITION_BLOCK = '''    if (req.user.userType !== 'admin' && req.user._id !== req.params.userId) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
'''
FIXED_MESSAGE = "        message: 'Access to another wallet is not permitted',\n"
HELPER = HELPER_DECL + '''  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  try {
''' + IDENTITY_BLOCK + '''        message: 'Authentication is required',
      });
    }

''' + CONDITION_BLOCK + FIXED_MESSAGE + '''      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

'''
REQUIRE_ADMIN_PRINCIPAL = '''    if (!req.user) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED','''
REQUIRE_ADMIN_ROLE = '''    if (req.user.userType !== 'admin') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN','''
REGISTRATION = re.compile(r"walletRouter\.(get|post|put|patch|delete)\(\n  '([^']*)',\n(.*?)\n\);", re.S)
LOOSE_COMPARISON = re.compile(r'(?<![=!<>])==(?!=)|!=(?!=)')
CAST = re.compile(r'ObjectId|String\(|toString\(|toHexString|\.equals\(|Number\(|parseInt|\bas any\b|\bas unknown\b')
SERVICE_ACCESS = re.compile(r'Container|Service|Repository|walletController|\bawait\b|Model\b|findBy')


class Rejected(Exception):
    def __init__(self, check, reason):
        super().__init__(reason)
        self.check = check
        self.reason = reason


def require(condition, check, reason):
    if not condition:
        raise Rejected(check, reason)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def sha256(data):
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def registrations(text):
    return [(m.group(1), m.group(2), [line.strip().rstrip(',') for line in m.group(3).split('\n') if line.strip()])
            for m in REGISTRATION.finditer(text)]


def registration_span(text, method, path):
    marker = 'walletRouter.' + method + "(\n  '" + path + "',\n"
    assert text.count(marker) == 1, 'registration marker not unique: ' + method + ' ' + path
    start = text.index(marker)
    return start + len(marker), text.index('\n);', start)


def insert_guard(text, method, path, guard):
    start, _ = registration_span(text, method, path)
    return text[:start] + '  ' + guard + ',\n' + text[start:]


def baseline_sources():
    routes = git('show', BASELINE + ':' + ROUTES).decode('utf-8')
    auth = git('show', BASELINE + ':' + AUTH).decode('utf-8')
    assert sha256(routes) == ROUTES_BASELINE_SHA256, 'baseline routes hash changed'
    assert sha256(auth) == AUTH_BASELINE_SHA256, 'baseline auth hash changed'
    return routes, auth


def expected_routes(baseline):
    assert baseline.count(OLD_EXPRESS_IMPORT) == 1 and baseline.count(VALIDATE_IMPORT) == 1
    assert baseline.count(HELPER_ANCHOR) == 1
    text = baseline.replace(OLD_EXPRESS_IMPORT, IMPORT_LINES[0], 1)
    text = text.replace(VALIDATE_IMPORT, VALIDATE_IMPORT + IMPORT_LINES[1] + IMPORT_LINES[2], 1)
    text = text.replace(HELPER_ANCHOR, HELPER_ANCHOR + HELPER, 1)
    for method, path in ADMIN_ROUTES:
        text = insert_guard(text, method, path, ADMIN_GUARD)
    for method, path in OWN_ROUTES:
        text = insert_guard(text, method, path, OWN_GUARD)
    return text


def helper_body(text):
    start = text.index(HELPER_DECL)
    return text[start:text.index('\n};\n', start) + len('\n};\n')]


def semantic_checks(candidate, auth, baseline):
    base_regs = registrations(baseline)
    base_handlers = {(m, p): h for m, p, h in base_regs}

    for line in IMPORT_LINES:
        require(candidate.count(line) == 1, 'required_imports', 'missing or repeated import: ' + line.strip())

    regs = registrations(candidate)
    require([(m, p) for m, p, _ in regs] == [(m, p) for m, p, _ in base_regs], 'route_inventory',
            'route registrations differ from the nine baseline registrations')
    require(candidate.count('walletRouter.') == len(regs), 'route_inventory', 'unparsed or extra router call present')
    handlers = {(m, p): h for m, p, h in regs}

    for key in ADMIN_ROUTES:
        h = handlers[key]
        require(h[0] == ADMIN_GUARD and h.count(ADMIN_GUARD) == 1 and OWN_GUARD not in h and h[1:] == base_handlers[key],
                'admin_guard_first', 'requireAdmin is not the sole first guard on ' + ' '.join(key).upper())
    for key in OWN_ROUTES:
        h = handlers[key]
        require(h[0] == OWN_GUARD and h.count(OWN_GUARD) == 1 and ADMIN_GUARD not in h and h[1:] == base_handlers[key],
                'own_guard_first', 'own-or-admin guard is not the sole first guard on ' + ' '.join(key).upper())
    for key, h in handlers.items():
        if key not in ADMIN_ROUTES and key not in OWN_ROUTES:
            require(h == base_handlers[key], 'unguarded_routes_unchanged', 'out-of-scope route changed: ' + ' '.join(key).upper())

    require(candidate.count(HELPER_DECL) == 1, 'own_helper_present', 'own-or-admin helper declaration missing or repeated')
    first_use = candidate.find('  ' + OWN_GUARD + ',\n')
    require(first_use == -1 or candidate.index(HELPER_DECL) < first_use, 'own_helper_present', 'helper declared after first use')
    body = helper_body(candidate)
    require(not LOOSE_COMPARISON.search(body), 'own_helper_strict_comparison', 'loose equality in own-or-admin helper')
    require(not CAST.search(body), 'own_helper_no_cast', 'type cast or conversion in own-or-admin helper')
    require(not SERVICE_ACCESS.search(body), 'own_helper_no_service_access', 'service/DB access in own-or-admin helper')
    require(body.count(IDENTITY_BLOCK) == 1, 'own_helper_identity_guard', 'missing-principal 401 guard absent')
    require(body.count(CONDITION_BLOCK) == 1 and body.index(IDENTITY_BLOCK) < body.index(CONDITION_BLOCK),
            'own_helper_condition', 'strict non-admin owner comparison with fixed 403 absent or misordered')
    require(body.index('next(') > body.index(CONDITION_BLOCK) and body.count('    next();\n') == 1,
            'own_helper_check_before_next', 'next() can run before the owner comparison')
    require(body.count('message: ') == 2 and body.count(FIXED_MESSAGE) == 1 and '`' not in body and '${' not in body
            and body.count('req.params') == 1, 'own_helper_fixed_message', '403 message not fixed or echoes request data')

    start = auth.index('export const requireAdmin = (')
    admin_body = auth[start:auth.index('\n};\n', start)]
    require(admin_body.count(REQUIRE_ADMIN_PRINCIPAL) == 1 and admin_body.count(REQUIRE_ADMIN_ROLE) == 1
            and admin_body.index(REQUIRE_ADMIN_PRINCIPAL) < admin_body.index(REQUIRE_ADMIN_ROLE) < admin_body.index('    next();')
            and not SERVICE_ACCESS.search(admin_body), 'require_admin_semantics', 'requireAdmin principal/admin checks changed')


def check(candidate, auth, baseline, expected):
    semantic_checks(candidate, auth, baseline)
    require(candidate == expected, 'exact_transform', 'routes file differs from the reviewed transformation')


def tree_checks():
    for path in PINNED:
        require((ROOT / path).read_bytes() == git('show', BASELINE + ':' + path), 'pinned_files', 'pinned file changed: ' + path)
    changed = git('diff', '--name-only', BASELINE, '--', 'src1', 'test').decode().split()
    require(changed == [ROUTES], 'diff_scope', 'source/test diff is not exactly the wallet routes file: ' + ','.join(changed))
    untracked = git('ls-files', '--others', '--exclude-standard', '--', 'src1', 'test').decode().split()
    require(not untracked, 'untracked_scope', 'untracked source/test files: ' + ','.join(untracked))


def remove_line(text, method, path, guard):
    start, end = registration_span(text, method, path)
    block = text[start:end]
    assert block.count('  ' + guard + ',\n') == 1
    return text[:start] + block.replace('  ' + guard + ',\n', '', 1) + text[end:]


def move_after(text, method, path, guard, prefix):
    text = remove_line(text, method, path, guard)
    start, end = registration_span(text, method, path)
    block = text[start:end]
    line_start = block.index('  ' + prefix)
    line_end = block.index('\n', line_start) + 1 if '\n' in block[line_start:] else len(block)
    if line_end == len(block):
        block = block + ',\n  ' + guard
    else:
        block = block[:line_end] + '  ' + guard + ',\n' + block[line_end:]
    return text[:start] + block + text[end:]


def swap_guard(text, wrong):
    for method, path in ADMIN_ROUTES:
        start, end = registration_span(text, method, path)
        text = text[:start] + text[start:end].replace('  ' + ADMIN_GUARD + ',\n', '  ' + wrong + ',\n', 1) + text[end:]
    return text.replace(IMPORT_LINES[2], IMPORT_LINES[2] + 'import { ' + wrong + " } from '@/modules/middleware/auth';\n", 1)


def controls(baseline, expected, auth):
    helper = helper_body(expected)
    cases = [('baseline_original', baseline, auth)]
    for method, path in ADMIN_ROUTES:
        name = 'get_root_left_open' if (method, path) == ('get', '/') else 'admin_guard_removed:' + method.upper() + ' ' + path
        cases.append((name, remove_line(expected, method, path, ADMIN_GUARD), auth))
    for method, path in ADMIN_ROUTES:
        cases.append(('admin_guard_after_validate:' + method.upper() + ' ' + path,
                      move_after(expected, method, path, ADMIN_GUARD, 'validate('), auth))
    for method, path in OWN_ROUTES:
        cases.append(('own_guard_removed:GET ' + path, remove_line(expected, method, path, OWN_GUARD), auth))
        cases.append(('own_guard_after_validate:GET ' + path, move_after(expected, method, path, OWN_GUARD, 'validate('), auth))
    for wrong in ('requireAdminOrOperationalPharmacy', 'authenticate', 'requireAdminOrHR'):
        cases.append(('wrong_guard_' + wrong, swap_guard(expected, wrong), auth))
    partial = expected
    for method, path in (('put', '/:id'), ('get', '/')):
        partial = remove_line(partial, method, path, ADMIN_GUARD)
    for method, path in OWN_ROUTES:
        partial = remove_line(partial, method, path, OWN_GUARD)
    cases.append(('guards_on_some_routes_only', partial, auth))
    strict = "req.user._id !== req.params.userId"
    cases.extend([
        ('own_check_loose_inequality', expected.replace(strict, 'req.user._id != req.params.userId', 1), auth),
        ('own_check_objectid_cast', expected.replace(strict, 'String(new Types.ObjectId(req.user._id)) !== String(new Types.ObjectId(req.params.userId))', 1), auth),
        ('own_check_after_service_call', move_after(expected, 'get', '/user/:userId', OWN_GUARD, 'catchAsync('), auth),
        ('own_check_next_before_compare', expected.replace(helper, helper.replace('  try {\n', '  try {\n    next();\n', 1), 1), auth),
        ('own_check_inverted', expected.replace(strict, 'req.user._id === req.params.userId', 1), auth),
        ('own_check_missing_identity_guard', expected.replace('    if (!req.user?._id) {\n', '    if (false) {\n', 1), auth),
        ('own_message_echoes_identifier', expected.replace(FIXED_MESSAGE, '        message: `Access to wallet ${req.params.userId} is not permitted`,\n', 1), auth),
        ('own_helper_declared_after_use', expected.replace(helper, '', 1).replace('export default walletRouter;\n', helper + 'export default walletRouter;\n', 1), auth),
        ('guard_added_to_recharge', insert_guard(expected, 'post', '/recharge/initiate', ADMIN_GUARD), auth),
        ('duplicate_unguarded_transactions_route', expected.replace(
            '// Add wallet transaction (credit/debit)\n',
            "walletRouter.post(\n  '/transactions',\n  validate(createWalletTransactionSchema, 'body'),\n  catchAsync(walletController.addTransaction)\n);\n\n"
            '// Add wallet transaction (credit/debit)\n', 1), auth),
        ('import_path_changed', expected.replace(IMPORT_LINES[2], "import { AuthRequest, requireAdmin } from '@/modules/middleware';\n", 1), auth),
        ('requireAdmin_weakened', expected, auth.replace("    if (req.user.userType !== 'admin') {", "    if (req.user.userType !== 'admin' && req.user.userType !== 'hr') {", 1)),
        ('requireAdmin_principal_check_removed', expected, auth.replace('    if (!req.user) {\n      throw new AppError({\n        status: 401,',
                                                                        '    if (false) {\n      throw new AppError({\n        status: 401,', 1)),
    ])
    return cases


def verify(negative_controls):
    baseline, auth = baseline_sources()
    expected = expected_routes(baseline)
    if negative_controls:
        check(expected, auth, baseline, expected)
        results = []
        for name, candidate, auth_text in controls(baseline, expected, auth):
            assert candidate != expected or auth_text != auth, 'control is not a mutation: ' + name
            try:
                check(candidate, auth_text, baseline, expected)
            except Rejected as rejection:
                if rejection.check == 'exact_transform':
                    raise AssertionError('control only rejected by exact comparison: ' + name)
                results.append({'control': name, 'rejected_by': rejection.check, 'reason': rejection.reason})
            else:
                raise AssertionError('source negative accepted: ' + name)
        return {'status': 'SOURCE_NEGATIVES_REJECTED', 'baseline': BASELINE, 'positive_control': 'expected_candidate_accepted',
                'control_count': len(results), 'controls': results, 'typescript_evaluations': 0}
    candidate = (ROOT / ROUTES).read_text(encoding='utf-8')
    check(candidate, (ROOT / AUTH).read_text(encoding='utf-8'), baseline, expected)
    tree_checks()
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'routes_baseline_sha256': ROUTES_BASELINE_SHA256, 'routes_candidate_sha256': sha256(candidate),
            'pinned_sha256': {path: sha256((ROOT / path).read_bytes()) for path in PINNED},
            'admin_guarded': [m.upper() + ' ' + p for m, p in ADMIN_ROUTES],
            'own_or_admin_guarded': [m.upper() + ' ' + p for m, p in OWN_ROUTES], 'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--negative-controls', action='store_true')
    options = parser.parse_args()
    try:
        print(json.dumps(verify(options.negative_controls)))
    except Rejected as failure:
        print(json.dumps({'status': 'REJECTED', 'check': failure.check, 'reason': failure.reason, 'typescript_evaluations': 0}))
        raise SystemExit(1)
    except AssertionError as failure:
        print(json.dumps({'status': 'HARNESS_FAILURE', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(2)

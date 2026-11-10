"""Verify the users-route authority amendment as source data, never as TypeScript.

The controller is read as text. Guard conditions are matched against a closed table of
literal source atoms; the matrix checks evaluate a Python decision model built from those
atoms. No TypeScript, extracted method, application, compiler, DB or provider is executed.
Every control must be rejected by a named semantic check before any exact comparison.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d'
SOURCE = 'src1/modules/user/controller/index.ts'
BASELINE_SHA256 = '7822f77598b7ad7ff1fa7ab32fca35d19a973de5d98ba43fca276f477525c5fc'
FORBIDDEN = ('isActive', 'isVerified', 'isCorporateEmailVerified', 'corporateId', 'isCorporateUser')
PINNED = (
    'src1/routes/index.ts',
    'src1/modules/user/routes/index.ts', 'src1/modules/user/validation/index.ts',
    'src1/modules/user/services/index.ts', 'src1/modules/user/repository/index.ts',
    'src1/modules/user/model/index.ts', 'src1/modules/user/types/index.ts',
    'src1/modules/middleware/auth.ts', 'src1/modules/middleware/errorHandler.ts',
    'src1/modules/middleware/index.ts', 'src1/modules/common/middleware/validation.ts',
    'src1/modules/common/utils/asyncHandler.ts', 'src1/modules/common/types/error.ts',
    'src1/modules/common/types/index.ts', 'src1/modules/common/repository/BaseRepository.ts',
    'src1/modules/auth/routes/index.ts', 'src1/modules/auth/controller/index.ts',
    'src1/modules/auth/services/index.ts', 'src1/modules/auth/validation/index.ts',
    'package.json', 'package-lock.json', 'tsconfig.json',
)

CONST_BLOCK = """const SELF_FORBIDDEN_FIELDS = [
  'isActive',
  'isVerified',
  'isCorporateEmailVerified',
  'corporateId',
  'isCorporateUser',
] as const;

"""

HELPERS = """  private assertUserRouteActor(req: AuthRequest, targetId?: string): void {
    if (!req.user?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (req.user.userType === 'admin') {
      return;
    }

    if (req.user.userType === 'hr') {
      if (!req.user.corporateId) {
        throw new AppError({
          status: 403,
          code: 'HR_CORPORATE_REQUIRED',
          message: 'HR account must be linked to a corporate',
        });
      }
      return;
    }

    if (
      req.user.userType === 'user' &&
      targetId !== undefined &&
      req.user._id === targetId
    ) {
      return;
    }

    throw new AppError({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Access to this user resource is not permitted',
    });
  }

  private assertNoSelfPrivilegeFields(req: AuthRequest): void {
    if (req.user?.userType !== 'user') {
      return;
    }

    const body = req.body ?? {};
    for (const field of SELF_FORBIDDEN_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        throw new AppError({
          status: 422,
          code: 'FORBIDDEN_FIELD',
          message: 'One or more fields cannot be changed through this endpoint',
        });
      }
    }
  }

  private assertHRListScope(req: AuthRequest): void {
    if (req.user?.userType === 'hr' && req.query.forUser === 'true') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'HR can only access users from their own corporate',
      });
    }
  }

"""

HELPER_PARAMS = {
    'assertUserRouteActor': 'req: AuthRequest, targetId?: string',
    'assertNoSelfPrivilegeFields': 'req: AuthRequest',
    'assertHRListScope': 'req: AuthRequest',
}
# handler -> (parameter extraction line or None, ordered guard calls with exact arguments)
WIRING = {
    'create': (None, [('assertUserRouteActor', 'req')]),
    'getAll': (None, [('assertUserRouteActor', 'req'), ('assertHRListScope', 'req')]),
    'getById': ('const { id } = req.params;', [('assertUserRouteActor', 'req, id')]),
    'update': ('const { id } = req.params;', [('assertUserRouteActor', 'req, id'),
                                              ('assertNoSelfPrivilegeFields', 'req')]),
    'delete': ('const { id } = req.params;', [('assertUserRouteActor', 'req, id')]),
}
HANDLERS = tuple(WIRING)
PREFIX_SHA256 = hashlib.sha256((CONST_BLOCK + HELPERS).encode()).hexdigest()


class Rejected(Exception):
    def __init__(self, check, detail=''):
        super().__init__(check + (': ' + detail if detail else ''))
        self.check = check


class ModelCrash(Exception):
    """A modeled property access on an absent principal (TypeError in the source)."""


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


# ---------------------------------------------------------------- expected source

def method_span(src, name):
    start = src.index('  ' + name + ' = async ')
    end = src.index('\n  };', start) + len('\n  };')
    return start, end


def expected_source():
    original = git('show', BASELINE + ':' + SOURCE).decode()
    assert hashlib.sha256(original.encode()).hexdigest() == BASELINE_SHA256, 'baseline hash changed'
    out = original.replace('export class UserController {', CONST_BLOCK + 'export class UserController {', 1)
    out = out.replace('  create = async ', HELPERS + '  create = async ', 1)
    for name, (param_line, calls) in WIRING.items():
        start, end = method_span(out, name)
        method = out[start:end]
        guard = ''.join('    this.%s(%s);\n' % (fn, args) for fn, args in calls)
        if param_line:
            anchor = '    ' + param_line + '\n'
            assert method.count(anchor) == 1
            method = method.replace(anchor, anchor + guard, 1)
        else:
            header_end = method.index('\n') + 1
            method = method[:header_end] + guard + method[header_end:]
        out = out[:start] + method + out[end:]
    return original, out


# ---------------------------------------------------------------- helper parsing

def helper_span(src, name):
    m = re.search(r'^  private (async )?' + name + r'\((.*)\)(: [^{\n]+)? \{$', src, re.M)
    if not m:
        raise Rejected('HELPER_PRESENT', name)
    body_start = m.end() + 1
    body_end = src.index('\n  }\n', m.end())
    return m, src[body_start:body_end]


def match_close(text, i, open_ch, close_ch):
    depth, quote = 0, None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in "'`\"":
            quote = ch
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise Rejected('CLOSED_VOCABULARY', 'unbalanced ' + open_ch)


def split_and(cond):
    parts, depth, cur, i = [], 0, '', 0
    while i < len(cond):
        if cond.startswith(' && ', i) and depth == 0:
            parts.append(cur.strip())
            cur, i = '', i + 4
            continue
        depth += {'(': 1, ')': -1}.get(cond[i], 0)
        cur += cond[i]
        i += 1
    parts.append(cur.strip())
    return parts


def principal(env, optional):
    if env['user'] is None:
        if optional:
            return {}
        raise ModelCrash()
    return env['user']


def js_truthy(value):
    if value is None or value is False or value == '':
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value == 0:
        return False
    return True


def strict_equal(left, right, op):
    same = type(left) is type(right) and left == right
    return same if op == '===' else not same


def atom(text):
    """Map one literal condition atom to a Python predicate over the synthetic environment."""
    if text == '!req.user?._id':
        return lambda env: not js_truthy((env['user'] or {}).get('_id'))
    if text in ('false', 'true'):
        return lambda env, v=(text == 'true'): v
    m = re.fullmatch(r"req\.user(\?)?\.userType (===|!==) '([A-Za-z_ ]*)'", text)
    if m:
        return lambda env, o=bool(m.group(1)), op=m.group(2), v=m.group(3): strict_equal(
            principal(env, o).get('userType'), v, op)
    m = re.fullmatch(r'!req\.user(\?)?\.corporateId', text)
    if m:
        return lambda env, o=bool(m.group(1)): not js_truthy(principal(env, o).get('corporateId'))
    m = re.fullmatch(r'targetId (===|!==) undefined', text)
    if m:
        return lambda env, op=m.group(1): (env['target'] is None) == (op == '===')
    m = re.fullmatch(r'req\.user(\?)?\._id (===|!==) targetId', text)
    if m:
        return lambda env, o=bool(m.group(1)), op=m.group(2): strict_equal(
            principal(env, o).get('_id'), env['target'], op)
    m = re.fullmatch(r"req\.query\.forUser (===|!==) ('true'|true)", text)
    if m:
        literal = 'true' if m.group(2) == "'true'" else True
        return lambda env, op=m.group(1), v=literal: strict_equal(env['query'].get('forUser'), v, op)
    if text == 'Object.prototype.hasOwnProperty.call(body, field)':
        return lambda env: env['field'] in env['body']
    if text == 'body[field]':
        return lambda env: js_truthy(env['body'].get(env['field']))
    m = re.fullmatch(r'body\[field\] (===|!==) undefined', text)
    if m:
        return lambda env, op=m.group(1): (env['body'].get(env['field']) is None) == (op == '===')
    raise Rejected('CLOSED_VOCABULARY', 'unsupported condition atom: ' + text)


def parse_block(text):
    stmts, i = [], 0
    while True:
        while i < len(text) and text[i] in ' \n':
            i += 1
        if i >= len(text):
            return stmts
        if text.startswith('if (', i):
            p = text.index('(', i)
            q = match_close(text, p, '(', ')')
            cond = re.sub(r'\s+', ' ', text[p + 1:q]).strip()
            b = q + 1
            while text[b] in ' \n':
                b += 1
            if text[b] != '{':
                raise Rejected('CLOSED_VOCABULARY', 'if without block')
            e = match_close(text, b, '{', '}')
            stmts.append(('if', [atom(a) for a in split_and(cond)], parse_block(text[b + 1:e])))
            i = e + 1
        elif text.startswith('for (', i):
            p = text.index('(', i)
            q = match_close(text, p, '(', ')')
            m = re.fullmatch(r'const field of ([A-Z_]+)', text[p + 1:q].strip())
            b = text.index('{', q)
            e = match_close(text, b, '{', '}')
            if not m:
                raise Rejected('CLOSED_VOCABULARY', 'unsupported loop')
            stmts.append(('for', m.group(1), parse_block(text[b + 1:e])))
            i = e + 1
        elif text.startswith('return;', i):
            stmts.append(('return',))
            i += len('return;')
        elif text.startswith('throw new AppError({', i):
            e = text.index('});', i) + 3
            seg = text[i:e]
            status = re.search(r'status: (\d+),', seg)
            code = re.search(r"code: '([A-Z_]+)',", seg)
            if not status or not code:
                raise Rejected('CLOSED_VOCABULARY', 'unsupported AppError')
            stmts.append(('throw', int(status.group(1)), code.group(1)))
            i = e
        elif text.startswith('const body = req.body ?? {};', i):
            stmts.append(('bind_body',))
            i += len('const body = req.body ?? {};')
        else:
            raise Rejected('CLOSED_VOCABULARY', 'unsupported statement: ' + text[i:i + 50].split('\n')[0])


def run_model(stmts, env):
    for st in stmts:
        if st[0] == 'if':
            if all(pred(env) for pred in st[1]):
                result = run_model(st[2], env)
                if result is not None:
                    return result
        elif st[0] == 'return':
            return ('allow',)
        elif st[0] == 'throw':
            return ('deny', st[1], st[2])
        elif st[0] == 'bind_body':
            env['body'] = env['req_body'] if env['req_body'] is not None else {}
        elif st[0] == 'for':
            for value in env['consts'][st[1]]:
                env['field'] = value
                result = run_model(st[2], env)
                if result is not None:
                    return result
    return None


def outcome(stmts, consts, user=None, target=None, query=None, req_body=None):
    env = {'user': user, 'target': target, 'query': query or {}, 'req_body': req_body,
           'body': {}, 'consts': consts, 'field': None}
    try:
        return run_model(stmts, env) or ('allow',)
    except ModelCrash:
        return ('crash',)


# ---------------------------------------------------------------- semantic checks

ADMIN = {'_id': 'ADM', 'userType': 'admin'}
HR = {'_id': 'HR1', 'userType': 'hr', 'corporateId': 'C1'}
PATIENT = {'_id': 'A', 'userType': 'user'}
ALLOW, D401, D403, D403HR, D422 = (('allow',), ('deny', 401, 'UNAUTHORIZED'), ('deny', 403, 'FORBIDDEN'),
                                    ('deny', 403, 'HR_CORPORATE_REQUIRED'), ('deny', 422, 'FORBIDDEN_FIELD'))
ACTOR_MATRIX = (
    ('IDENTITY_401', D401, [(None, None), (None, 'A'), ({'userType': 'user'}, 'A'),
                            ({'_id': '', 'userType': 'admin'}, None)]),
    ('ADMIN_ALLOWED', ALLOW, [(ADMIN, None), (ADMIN, 'A')]),
    ('HR_CORPORATE_REQUIRED', D403HR, [({'_id': 'HR2', 'userType': 'hr'}, None),
                                       ({'_id': 'HR2', 'userType': 'hr', 'corporateId': ''}, 'A')]),
    ('HR_SCOPED_ALLOWED', ALLOW, [(HR, None), (HR, 'A')]),
    ('OWN_USER_ALLOWED', ALLOW, [(PATIENT, 'A'), (dict(PATIENT, corporateId='C1'), 'A')]),
    ('CROSS_USER_DENIED', D403, [(PATIENT, 'B'), (PATIENT, 'a')]),
    ('TARGETLESS_USER_DENIED', D403, [(PATIENT, None)]),
    ('OTHER_TYPES_DENIED', D403, [({'_id': 'S', 'userType': 'specialist', 'specialistId': 'S'}, 'S'),
                                  ({'_id': 'S', 'userType': 'specialist'}, None),
                                  ({'_id': 'P', 'userType': 'pharmacy', 'pharmacyId': 'P'}, 'P'),
                                  ({'_id': 'P', 'userType': 'pharmacy'}, None)]),
    ('UNKNOWN_TYPES_DENIED', D403, [({'_id': 'X', 'userType': 'superadmin'}, 'X'),
                                    ({'_id': 'X', 'userType': ''}, 'X'),
                                    ({'_id': 'X', 'userType': 'Admin'}, None),
                                    ({'_id': 'X'}, 'X')]),
)


def lexical_checks(src, failures):
    headers, bodies = {}, {}
    for name in HELPER_PARAMS:
        try:
            headers[name], bodies[name] = helper_span(src, name)
        except Rejected as r:
            failures.append(str(r))
    if len(bodies) < len(HELPER_PARAMS):
        return None
    for name, m in headers.items():
        if m.group(1) or m.group(3) != ': void':
            failures.append('GUARD_SYNCHRONOUS: helper %s must be synchronous and return void' % name)
        if m.group(2) != HELPER_PARAMS[name]:
            failures.append('HELPER_SIGNATURE: ' + name)
    if re.search(r'\btry\s*\{|\bcatch\b|\.catch\(|\.then\(', src):
        failures.append('NO_TRY_CATCH: controller must not catch or defer guard failures')
    actor = bodies['assertUserRouteActor']
    if re.search(r'String\(|toString\(|ObjectId|Types\.|Number\(|parseInt|[^=!<>]==[^=]|!=[^=]', actor):
        failures.append('STRICT_STRING_EQUALITY: own-ID comparison must be strict string === without casts')
    for name, body in bodies.items():
        if '`' in body or '${' in body or len(re.findall(r'message:', body)) != len(
                re.findall(r"message: '[^'$`]*',", body)):
            failures.append('FIXED_DENIAL_MESSAGE: ' + name)
    const = re.search(r'^const SELF_FORBIDDEN_FIELDS = \[(.*?)\] as const;$', src, re.M | re.S)
    fields = re.findall(r"'([A-Za-z]+)'", const.group(1)) if const else []
    if sorted(fields) != sorted(FORBIDDEN) or len(fields) != len(set(fields)):
        failures.append('FIELD_LIST_COMPLETE: forbidden keys must be exactly ' + ', '.join(FORBIDDEN))
    fbody = bodies['assertNoSelfPrivilegeFields']
    if fbody.count('const body = req.body ?? {};') != 1 or len(re.findall(r'const body =', fbody)) != 1:
        failures.append('FIELD_SOURCE_REQ_BODY: field guard must inspect the raw request body')
    if re.search(r'\bdelete\b', fbody) or "status: 422,\n          code: 'FORBIDDEN_FIELD'," not in fbody:
        failures.append('FIELD_REJECT_422: forbidden fields must be rejected with 422, never stripped')
    parsed = {}
    for name, body in bodies.items():
        try:
            parsed[name] = parse_block(body)
        except Rejected as r:
            failures.append(str(r))
    return (parsed, {'SELF_FORBIDDEN_FIELDS': tuple(fields)}) if len(parsed) == len(bodies) else None


def model_checks(parsed, consts, failures):
    actor, fields, hr_list = (parsed['assertUserRouteActor'], parsed['assertNoSelfPrivilegeFields'],
                              parsed['assertHRListScope'])
    for check, want, cases in ACTOR_MATRIX:
        for user, target in cases:
            got = outcome(actor, consts, user=user, target=target)
            if got != want:
                failures.append('%s: actor=%s target=%s got %s' % (check, user, target, got))
                break
    for field in FORBIDDEN:
        bad = [v for v in (True, False, None, 0, '', 'x')
               if outcome(fields, consts, user=PATIENT, req_body={'name': 'N', field: v}) != D422]
        if bad:
            failures.append('FIELD_KEY_PRESENCE: %s with values %r was not rejected' % (field, bad))
            break
    for body in ({'name': 'N', 'city': 'C', 'state': 'S'}, {'email': 'a@b.c', 'phone': '1', 'corporateEmail': 'x@y.z'},
                 None):
        if outcome(fields, consts, user=PATIENT, req_body=body) != ALLOW:
            failures.append('FIELD_ALLOWS_PROFILE: ordinary own-profile body rejected: %r' % (body,))
            break
    privileged = {f: True for f in FORBIDDEN}
    for user in (ADMIN, HR):
        if outcome(fields, consts, user=user, req_body=privileged) != ALLOW:
            failures.append('FIELD_SCOPE_PATIENT: field guard must not change %s behaviour' % user['userType'])
            break
    if outcome(hr_list, consts, user=HR, query={'forUser': 'true'}) != D403:
        failures.append('HR_FOR_USER_DENIED: HR forUser=true must be 403')
    for query in ({'forUser': 'false'}, {}):
        if outcome(hr_list, consts, user=HR, query=query) != ALLOW:
            failures.append('HR_FOR_USER_FALSE_ALLOWED: %r' % (query,))
            break
    for user in (ADMIN, PATIENT):
        if outcome(hr_list, consts, user=user, query={'forUser': 'true'}) != ALLOW:
            failures.append('ADMIN_FOR_USER_ALLOWED: HR list denial must not apply to ' + user['userType'])
            break


def wiring_checks(src, failures):
    for name, (param_line, calls) in WIRING.items():
        try:
            start, end = method_span(src, name)
        except ValueError:
            failures.append('GUARD_ORDER: handler missing: ' + name)
            continue
        lines = [ln.strip() for ln in src[start:end].split('\n')[1:] if ln.strip()]
        if param_line:
            if not lines or lines[0] != param_line:
                failures.append('GUARD_ORDER: %s must extract its target first' % name)
                continue
            lines = lines[1:]
        lead = [re.fullmatch(r'this\.(assert\w+)\((.*)\);', ln) for ln in lines[:len(calls)]]
        names = [m.group(1) if m else None for m in lead]
        method = src[start:end]
        if names != [fn for fn, _ in calls] or any(
                len(re.findall(r'this\.' + fn + r'\(', method)) != 1 for fn, _ in calls):
            failures.append('GUARD_ORDER: %s guards must be the first statements, once, in order %s'
                            % (name, [fn for fn, _ in calls]))
            continue
        if re.search(r'(await|void|return)\s+this\.assert', method):
            failures.append('GUARD_SYNCHRONOUS: %s guard call must be a bare synchronous statement' % name)
        args = [m.group(2) for m in lead]
        if args != [a for _, a in calls]:
            failures.append('GUARD_TARGET: %s guard arguments %s, expected %s' % (name, args, [a for _, a in calls]))


def semantic_failures(src):
    failures = []
    parsed = lexical_checks(src, failures)
    if parsed:
        model_checks(parsed[0], parsed[1], failures)
    wiring_checks(src, failures)
    return failures


def first_check(failure):
    return failure.split(':', 1)[0]


def check(candidate, expected):
    """Return None if accepted, else (rejecting check, all failures). Exact match runs last."""
    failures = semantic_failures(candidate)
    if failures:
        return first_check(failures[0]), failures
    if candidate != expected:
        return 'EXACT_AMENDMENT', ['EXACT_AMENDMENT: unexpected controller change beyond the reviewed amendment']
    return None


def tree_checks():
    for path in PINNED:
        if (ROOT / path).read_bytes() != git('show', BASELINE + ':' + path):
            return 'PROTECTED_PINS', ['PROTECTED_PINS: ' + path]
    changed = git('diff', '--name-only', BASELINE, '--', 'src1').decode().split()
    untracked = git('ls-files', '--others', '--exclude-standard', '--', 'src1').decode().split()
    if changed + untracked not in ([SOURCE], []):
        return 'PRODUCTION_DIFF_SCOPE', ['PRODUCTION_DIFF_SCOPE: %s' % (changed + untracked)]
    return None


# ---------------------------------------------------------------- negative controls

def mutate(text, old, new, count=1):
    assert text.count(old) >= 1, 'control anchor missing: ' + old[:60]
    return text.replace(old, new, count)


def in_method(src, name, old, new):
    start, end = method_span(src, name)
    return src[:start] + mutate(src[start:end], old, new) + src[end:]


def controls(original, expected):
    cases = [('baseline_controller', original, 'HELPER_PRESENT')]
    service_line = {'create': '    const user = await this.userService.create(data);\n',
                    'getAll': '    const users = await this.userService.findAll(queryParams);\n',
                    'getById': '    const user = await this.userService.getById(id);\n',
                    'update': '    const user = await this.userService.update(id, data);\n',
                    'delete': '    await this.userService.delete(id);\n'}
    for name in HANDLERS:
        args = 'req, id' if WIRING[name][0] else 'req'
        call = '    this.assertUserRouteActor(%s);\n' % args
        cases.append((name + '_actor_guard_removed', in_method(expected, name, call, ''), 'GUARD_ORDER'))
        moved = in_method(in_method(expected, name, call, ''), name, service_line[name], service_line[name] + call)
        cases.append((name + '_actor_guard_after_service', moved, 'GUARD_ORDER'))
    actor_cond = "      req.user.userType === 'user' &&\n      targetId !== undefined &&\n      req.user._id === targetId\n"
    hr_block = ("      if (!req.user.corporateId) {\n        throw new AppError({\n          status: 403,\n"
                "          code: 'HR_CORPORATE_REQUIRED',\n          message: 'HR account must be linked to a corporate',\n"
                "        });\n      }\n")
    field_call = '    this.assertNoSelfPrivilegeFields(req);\n'
    hr_call = '    this.assertHRListScope(req);\n'
    cases += [
        ('inverted_own_id_comparison', mutate(expected, 'req.user._id === targetId', 'req.user._id !== targetId'),
         'CROSS_USER_DENIED'),
        ('identity_check_disabled', mutate(expected, 'if (!req.user?._id) {', 'if (false) {'), 'IDENTITY_401'),
        ('targetless_user_admitted_on_create',
         in_method(expected, 'create', 'this.assertUserRouteActor(req);', 'this.assertUserRouteActor(req, req.user?._id);'),
         'GUARD_TARGET'),
        ('non_user_type_admitted_as_owner', mutate(expected, "      req.user.userType === 'user' &&\n", ''),
         'OTHER_TYPES_DENIED'),
        ('unknown_type_admitted_by_deny_list',
         mutate(expected, actor_cond, "      req.user.userType !== 'specialist' &&\n      req.user.userType !== 'pharmacy' &&\n"
                "      targetId !== undefined &&\n      req.user._id === targetId\n"), 'UNKNOWN_TYPES_DENIED'),
        ('hr_without_corporate_admitted', mutate(expected, hr_block, ''), 'HR_CORPORATE_REQUIRED'),
        ('id_cast_comparison', mutate(expected, 'req.user._id === targetId', 'String(req.user._id) === String(targetId)'),
         'STRICT_STRING_EQUALITY'),
        ('loose_id_comparison', mutate(expected, 'req.user._id === targetId', 'req.user._id == targetId'),
         'STRICT_STRING_EQUALITY'),
        ('denial_message_echoes_id',
         mutate(expected, "message: 'Access to this user resource is not permitted',",
                'message: `Access to user ${targetId} is not permitted`,'), 'FIXED_DENIAL_MESSAGE'),
        ('actor_guard_async_unawaited',
         mutate(expected, '  private assertUserRouteActor(req: AuthRequest, targetId?: string): void {',
                '  private async assertUserRouteActor(req: AuthRequest, targetId?: string): Promise<void> {'),
         'GUARD_SYNCHRONOUS'),
        ('actor_guard_wrapped_in_try_catch',
         in_method(expected, 'getById', '    this.assertUserRouteActor(req, id);\n',
                   '    try {\n      this.assertUserRouteActor(req, id);\n    } catch {\n      // ignored\n    }\n'),
         'NO_TRY_CATCH'),
    ]
    for field in FORBIDDEN:
        cases.append(('forbidden_field_omitted_' + field, mutate(expected, "  '%s',\n" % field, ''),
                      'FIELD_LIST_COMPLETE'))
    cases += [
        ('forbidden_list_overreaches_name', mutate(expected, "  'isCorporateUser',\n", "  'isCorporateUser',\n  'name',\n"),
         'FIELD_LIST_COMPLETE'),
        ('field_check_by_truthiness',
         mutate(expected, 'if (Object.prototype.hasOwnProperty.call(body, field)) {', 'if (body[field]) {'),
         'FIELD_KEY_PRESENCE'),
        ('field_check_on_merged_data',
         mutate(expected, 'const body = req.body ?? {};',
                'const body = { ...req.body, corporateId: req.body?.corporateId };'), 'FIELD_SOURCE_REQ_BODY'),
        ('field_stripped_not_rejected',
         mutate(expected, "        throw new AppError({\n          status: 422,\n          code: 'FORBIDDEN_FIELD',\n"
                "          message: 'One or more fields cannot be changed through this endpoint',\n        });\n",
                '        delete body[field];\n'), 'FIELD_REJECT_422'),
        ('field_guard_before_actor_guard',
         in_method(expected, 'update', '    this.assertUserRouteActor(req, id);\n' + field_call,
                   field_call + '    this.assertUserRouteActor(req, id);\n'), 'GUARD_ORDER'),
        ('field_guard_after_service',
         in_method(in_method(expected, 'update', field_call, ''), 'update', service_line['update'],
                   service_line['update'] + field_call), 'GUARD_ORDER'),
        ('field_guard_applies_to_admin',
         mutate(expected, "    if (req.user?.userType !== 'user') {\n      return;\n    }\n",
                "    if (req.user?.userType === 'hr') {\n      return;\n    }\n"), 'FIELD_SCOPE_PATIENT'),
        ('hr_for_user_denial_removed', in_method(expected, 'getAll', hr_call, ''), 'GUARD_ORDER'),
        ('for_user_compared_to_boolean',
         mutate(expected, "req.query.forUser === 'true') {", 'req.query.forUser === true) {'), 'HR_FOR_USER_DENIED'),
        ('admin_for_user_denied',
         mutate(expected, "if (req.user?.userType === 'hr' && req.query.forUser === 'true') {",
                "if (req.query.forUser === 'true') {"), 'ADMIN_FOR_USER_ALLOWED'),
        ('admin_routes_denied', mutate(expected, "    if (req.user.userType === 'admin') {\n      return;\n    }\n\n", ''),
         'ADMIN_ALLOWED'),
        ('own_id_denied', mutate(expected, '    if (\n' + actor_cond + '    ) {\n      return;\n    }\n\n', ''),
         'OWN_USER_ALLOWED'),
        ('own_id_routes_pass_no_target',
         in_method(expected, 'update', 'this.assertUserRouteActor(req, id);', 'this.assertUserRouteActor(req);'),
         'GUARD_TARGET'),
    ]
    return cases


def verify(negative_controls):
    original, expected = expected_source()
    if negative_controls:
        if semantic_failures(expected):
            raise AssertionError('Expected amendment fails semantics: %s' % semantic_failures(expected))
        results = []
        for name, candidate, want in controls(original, expected):
            outcome_ = check(candidate, expected)
            if outcome_ is None:
                raise AssertionError('Source negative accepted: ' + name)
            rejected_by, failures = outcome_
            if rejected_by == 'EXACT_AMENDMENT':
                raise AssertionError('Control rejected only by exact comparison: ' + name)
            if want not in [first_check(f) for f in failures]:
                raise AssertionError('Control %s not rejected by %s: %s' % (name, want, failures))
            results.append({'control': name, 'rejected_by': rejected_by,
                            'semantic_failures': [first_check(f) for f in failures]})
        return {'status': 'SOURCE_NEGATIVES_REJECTED', 'control_count': len(results), 'controls': results,
                'exact_comparison_rejections': 0, 'typescript_evaluations': 0}
    candidate = (ROOT / SOURCE).read_text()
    outcome_ = check(candidate, expected) or tree_checks()
    if outcome_:
        raise AssertionError(outcome_[1][0])
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'source_sha256': hashlib.sha256(expected.encode()).hexdigest(),
            'frozen_prefix_sha256': PREFIX_SHA256, 'guarded_handlers': list(HANDLERS),
            'pinned_files': len(PINNED), 'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--negative-controls', action='store_true')
    options = parser.parse_args()
    try:
        print(json.dumps(verify(options.negative_controls)))
    except AssertionError as failure:
        print(json.dumps({'status': 'REJECTED', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(1)

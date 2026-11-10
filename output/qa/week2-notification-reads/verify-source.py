"""Exact bounded source transformation; TypeScript is bytes, never executable."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
QA = 'output/qa/week2-notification-reads/'
BASE = 'd91e1a3d37f2b229efc7fc2507d666ddc2576d99'
CONTRACT_SHA = 'f24cd44e9ae5a9734b255c426854f5a0cb8efb56b3c9be6f911a2a3435b2aeb1'
CONTROLLER = 'src1/modules/notification/controller/index.ts'
FCM_ROUTES = 'src1/modules/fcm/routes/index.ts'
PRODUCTION = {CONTROLLER, FCM_ROUTES}


def need(ok, code):
    if not ok:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path):
    file = ROOT / path
    metadata = file.lstat()
    need(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'NONREGULAR_INPUT')
    return file.read_bytes()


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/tmp'})


def once(text, before, after):
    need(text.count(before) == 1, 'AMBIGUOUS_TRANSFORMATION')
    return text.replace(before, after)


HELPERS = """  private requireCanonicalRecipient(req: AuthRequest): NonNullable<AuthRequest['user']> {
    const actor = req.user;
    if (!actor || typeof actor._id !== 'string' || actor._id.trim().length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    return actor;
  }

  private resolveListRecipient(req: AuthRequest): string | undefined {
    const actor = this.requireCanonicalRecipient(req);
    const requestedRecipient = req.query.userId as string | undefined;
    if (actor.userType === 'admin') {
      return requestedRecipient;
    }

    if (requestedRecipient !== undefined) {
      this.assertOwnRecipient(req, requestedRecipient);
    }

    return actor._id;
  }

  private async getAuthorizedNotification(req: AuthRequest, id: string) {
    const actor = this.requireCanonicalRecipient(req);
    const notification = await this.notificationService.getById(id);
    if (actor.userType !== 'admin') {
      this.assertOwnRecipient(req, notification.userId);
    }

    return notification;
  }

"""


def transform_controller(old):
    start = '  create = async (req: Request, res: Response, _next: NextFunction) => {\n'
    text = once(old, start, HELPERS + start)
    for method in ['getById', 'getAll', 'update', 'markAsRead', 'delete']:
        before = '  ' + method + ' = async (req: Request, res: Response, _next: NextFunction) => {'
        text = once(text, before, before.replace('req: Request', 'req: AuthRequest'))
    before = """  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    const result = await this.notificationService.getById(id);"""
    text = once(text, before, before.replace('this.notificationService.getById(id)', 'this.getAuthorizedNotification(req, id)'))
    text = once(text, '      userId: req.query.userId as string,', '      userId: this.resolveListRecipient(req),')
    for method in ['update', 'markAsRead', 'delete']:
        before = '  ' + method + ' = async (req: AuthRequest, res: Response, _next: NextFunction) => {\n    const { id } = req.params;'
        text = once(text, before, before + '\n    await this.getAuthorizedNotification(req, id);')
    return text


def transform_fcm(old):
    text = once(old, "import { FcmController } from '@/modules/fcm/controller';",
                "import { FcmController } from '@/modules/fcm/controller';\nimport { requireAdmin } from '@/modules/middleware/auth';")
    return once(text, "  '/test',\n  validate(sendTestNotificationSchema, 'body'),",
                "  '/test',\n  requireAdmin,\n  validate(sendTestNotificationSchema, 'body'),")


def accepted(candidate, expected):
    return set(candidate) == PRODUCTION and all(candidate[path] == expected[path] for path in PRODUCTION)


def run():
    need(sys.flags.isolated and len(sys.argv) == 1 and not os.environ.get('PYTHONPATH'), 'FIXED_ISOLATED_INVOCATION')
    contract = read(QA + 'CONTRACT.md')
    need(sha(contract) == CONTRACT_SHA, 'CONTRACT_HASH')
    backend = contract.decode().split('Mobile files are read-only observations')[0]
    pins = dict(re.findall(r'\| \x60([^\x60]+)\x60 \| \x60([a-f0-9]{64})\x60 \|', backend))
    need(len(pins) == 28 and PRODUCTION <= set(pins), 'INPUT_PIN_SET')
    baseline = {}
    for path, digest in pins.items():
        before = git('show', BASE + ':' + path)
        need(sha(before) == digest, 'BASELINE_INPUT_HASH')
        if path in PRODUCTION:
            baseline[path] = before.decode()
        else:
            need(sha(read(path)) == digest, 'UNCHANGED_INPUT_HASH')
    expected = {CONTROLLER: transform_controller(baseline[CONTROLLER]),
                FCM_ROUTES: transform_fcm(baseline[FCM_ROUTES])}
    current = {path: read(path).decode() for path in PRODUCTION}
    need(accepted(current, expected), 'EXACT_NOTIFICATION_AMENDMENT_REQUIRED')
    need(not accepted(baseline, expected), 'BASELINE_NOT_REJECTED')
    changed = set(git('diff', '--name-only', BASE, '--').decode().splitlines())
    others = set(git('ls-files', '--others', '--exclude-standard').decode().splitlines())
    ignored = set(git('ls-files', '--others', '--ignored', '--exclude-standard').decode().splitlines())
    need(all(path in PRODUCTION or path.startswith(QA) for path in changed | others | ignored), 'WHOLE_TREE_SCOPE')
    need({path for path in changed if path.startswith('src1/')} == PRODUCTION, 'TWO_FILE_PRODUCTION_SCOPE')
    for path in PRODUCTION:
        need(git('ls-tree', BASE, '--', path).split()[0] == b'100644'
             and not (ROOT / path).stat().st_mode & 0o111, 'PRODUCTION_MODE')
    controls = []

    def mutate(name, path, before, after):
        variant = dict(expected)
        variant[path] = once(variant[path], before, after)
        need(not accepted(variant, expected), 'NEGATIVE_SOURCE_CONTROL_SURVIVED')
        controls.append({'id': name, 'status': 'REJECTED_AS_EXPECTED'})

    mutate('missing-canonical-principal-check', CONTROLLER,
           "!actor || typeof actor._id !== 'string' || actor._id.trim().length === 0", 'false')
    mutate('blank-canonical-principal-accepted', CONTROLLER, "actor._id.trim().length === 0", "actor._id.length === 0")
    mutate('principal-string-coercion', CONTROLLER, "typeof actor._id !== 'string'", "typeof String(actor._id) !== 'string'")
    mutate('list-owner-request-selected', CONTROLLER, '      userId: this.resolveListRecipient(req),', '      userId: req.query.userId as string,')
    mutate('list-owner-unscoped', CONTROLLER, '      userId: this.resolveListRecipient(req),', '      userId: undefined,')
    mutate('list-canonical-return-omitted', CONTROLLER, '    return actor._id;', '    return requestedRecipient;')
    mutate('list-explicit-owner-check-removed', CONTROLLER,
           '      this.assertOwnRecipient(req, requestedRecipient);', '')
    mutate('list-admin-case-folded', CONTROLLER, "if (actor.userType === 'admin')", "if (actor.userType.toLowerCase() === 'admin')")
    mutate('id-admin-case-folded', CONTROLLER, "if (actor.userType !== 'admin')", "if (actor.userType.toLowerCase() !== 'admin')")
    mutate('id-all-roles-global', CONTROLLER, "if (actor.userType !== 'admin')", 'if (false)')
    mutate('id-stored-owner-check-removed', CONTROLLER,
           '      this.assertOwnRecipient(req, notification.userId);', '')
    mutate('id-stored-owner-request-selected', CONTROLLER,
           'this.assertOwnRecipient(req, notification.userId)', 'this.assertOwnRecipient(req, req.query.userId as string)')
    mutate('id-get-unprotected', CONTROLLER,
           'const result = await this.getAuthorizedNotification(req, id);',
           'const result = await this.notificationService.getById(id);')
    for method, call in [('update', 'const result = await this.notificationService.update(id, data);'),
                         ('markAsRead', 'const result = await this.notificationService.markAsRead(id);'),
                         ('delete', 'await this.notificationService.delete(id);')]:
        start = '  ' + method + ' = async '
        offset = expected[CONTROLLER].index(start)
        end = expected[CONTROLLER].index('\n  };', offset) + len('\n  };')
        body = expected[CONTROLLER][offset:end]
        no_guard = once(body, '    await this.getAuthorizedNotification(req, id);\n', '')
        mutate(method + '-owner-preflight-removed', CONTROLLER, body, no_guard)
        late_guard = once(no_guard, '    ' + call, '    ' + call + '\n    await this.getAuthorizedNotification(req, id);')
        mutate(method + '-owner-preflight-after-effect', CONTROLLER, body, late_guard)
    mutate('legacy-strict-own-path-admin-expansion', CONTROLLER,
           '    if (req.user._id !== userId) {', "    if (req.user.userType !== 'admin' && req.user._id !== userId) {")
    mutate('legacy-strict-own-path-check-removed', CONTROLLER,
           '    if (req.user._id !== userId) {', '    if (false) {')
    mutate('legacy-specialist-alias-change', CONTROLLER,
           'const specialistId = req.user?.specialistId || req.user?._id || \'\';\n    const result = await this.notificationService.getBySpecialistId(specialistId);',
           'const specialistId = req.query.userId as string;\n    const result = await this.notificationService.getBySpecialistId(specialistId);')
    mutate('fcm-test-admin-removed', FCM_ROUTES, "  '/test',\n  requireAdmin,", "  '/test',")
    mutate('fcm-test-admin-after-validation', FCM_ROUTES,
           "  requireAdmin,\n  validate(sendTestNotificationSchema, 'body'),",
           "  validate(sendTestNotificationSchema, 'body'),\n  requireAdmin,")
    mutate('fcm-token-admin-restriction', FCM_ROUTES, "  '/token',", "  '/token',\n  requireAdmin,")
    mutate('fcm-router-wide-admin', FCM_ROUTES, 'const fcmController = new FcmController();',
           'const fcmController = new FcmController();\nfcmRouter.use(requireAdmin);')
    return {'schema': 'SD-NOTIFICATION-SOURCE-1', 'status': 'SOURCE_TRANSFORMATION_VERIFIED_RUNTIME_NOT_RUN',
            'baseline': BASE, 'contractSha': CONTRACT_SHA,
            'productionSha': {path: sha(read(path)) for path in sorted(PRODUCTION)},
            'verifierSha': sha(Path(__file__).read_bytes()), 'baselineRejection': 'REJECTED_AS_EXPECTED',
            'negativeSourceControls': controls, 'unchangedInputPins': len(pins) - len(PRODUCTION),
            'runtimeHTTP': 'NOT_RUN', 'applicationEvaluations': 0, 'compilerExecutions': 0,
            'databaseCalls': 0, 'providerCalls': 0, 'DockerCalls': 0}


if __name__ == '__main__':
    try:
        print(json.dumps(run(), indent=2))
    except RuntimeError as error:
        print(json.dumps({'schema': 'SD-NOTIFICATION-SOURCE-1', 'status': 'REJECTED', 'code': str(error)}))
        sys.exit(1)

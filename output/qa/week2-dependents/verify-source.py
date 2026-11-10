"""Read TypeScript as source data only. No application/compiler/provider execution."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
QA = 'output/qa/week2-dependents/'
BASE = 'cca8a5b453a35ce8517694568bd4c5f82c029e7e'
CONTRACT_SHA = '7ae9f137a64c037416eb401768de52b3b0936a3a68d7b6ccd9d232f4f0e4232f'
ORIGINAL_SHA = '48836e54089e460dee0476243655bfeca0e1245e58fa14b11c2335eff064729a'
CONTROLLER = 'src1/modules/dependents/controller/index.ts'
ROUTES = 'src1/modules/dependents/routes/index.ts'
PRODUCTION = {CONTROLLER, ROUTES}


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(relative):
    path = ROOT / relative
    metadata = path.lstat()
    need(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'NONREGULAR_INPUT')
    return path.read_bytes()


def git(*args):
    return subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args],
                                   cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/tmp'})


def once(text, before, after):
    need(text.count(before) == 1, 'AMBIGUOUS_TRANSFORMATION')
    return text.replace(before, after)


HELPERS = """  private requireActor(req: AuthRequest): NonNullable<AuthRequest['user']> {
    const actor = req.user;
    if (!actor || typeof actor._id !== 'string' || actor._id.trim().length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (actor.userType !== 'user' && actor.userType !== 'admin') {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to dependent resources is not permitted',
      });
    }

    return actor;
  }

  private resolveOwner(req: AuthRequest, requestedOwner?: string): string | undefined {
    const actor = this.requireActor(req);
    if (actor.userType === 'admin') {
      return requestedOwner;
    }

    if (requestedOwner !== undefined && requestedOwner !== actor._id) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to dependents owned by another user is not permitted',
      });
    }

    return actor._id;
  }

  authorize = (req: AuthRequest, _res: Response, next: NextFunction): void => {
    try {
      this.requireActor(req);
      next();
    } catch (error) {
      next(error);
    }
  };

  rejectOwnershipChange = async (
    req: AuthRequest,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    const userId = this.resolveOwner(req, req.query.userId as string | undefined);
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'userId')) {
      await this.dependentService.getById(req.params.id, userId);
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Dependent ownership cannot be changed through this endpoint',
      });
    }

    next();
  };

"""


def controller_transform(old):
    text = once(old, "import { Request, Response, NextFunction } from 'express';",
                "import { Response, NextFunction } from 'express';")
    text = once(text, "import { AuthRequest } from '@/modules/middleware/auth';",
                "import { AuthRequest } from '@/modules/middleware/auth';\nimport { AppError } from '@/modules/common/types';")
    need(text.count('req: Request') == 6, 'CONTROLLER_REQUEST_COUNT')
    text = text.replace('req: Request', 'req: AuthRequest')
    start = '  create = async (req: AuthRequest, res: Response, _next: NextFunction) => {\n'
    text = once(text, start, HELPERS + start)
    text = once(text, start + '    const data: CreateDependentRequest = req.body;',
                start + """    const actor = this.requireActor(req);
    if (actor.userType === 'user' && req.body.userId !== actor._id) {
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Dependent owner must match the authenticated user',
      });
    }

    const data: CreateDependentRequest = {
      ...req.body,
      userId: actor.userType === 'admin' ? req.body.userId : actor._id,
    };""")
    need(text.count('    const userId = req.query.userId as string | undefined;') == 3, 'ID_HANDLER_COUNT')
    text = text.replace('    const userId = req.query.userId as string | undefined;',
                        '    const userId = this.resolveOwner(req, req.query.userId as string | undefined);')
    text = once(text, """    const effectiveUserId =
      req.user?.userType === 'admin'
        ? (req.query.userId as string | undefined)
        : req.user?._id;""",
                '    const effectiveUserId = this.resolveOwner(req, req.query.userId as string | undefined);')
    need(text.count('    const { userId } = req.params;') == 2, 'PATH_HANDLER_COUNT')
    text = text.replace('    const { userId } = req.params;',
                        '    const userId = this.resolveOwner(req, req.params.userId) as string;')
    return text


def routes_transform(old):
    text = once(old, 'const dependentController = new DependentController();',
                'const dependentController = new DependentController();\n\ndependentRouter.use(dependentController.authorize);')
    return once(text, """  validate(idParamSchema, 'params'),
  validate(updateDependentSchema, 'body'),
  validate(dependentQuerySchema, 'query'),
  catchAsync(dependentController.update)""", """  validate(idParamSchema, 'params'),
  validate(dependentQuerySchema, 'query'),
  catchAsync(dependentController.rejectOwnershipChange),
  validate(updateDependentSchema, 'body'),
  catchAsync(dependentController.update)""")


def accepted(candidate, expected):
    return set(candidate) == PRODUCTION and all(candidate[path] == expected[path] for path in PRODUCTION)


def run():
    need(sys.flags.isolated and len(sys.argv) == 1 and not os.environ.get('PYTHONPATH'), 'FIXED_ISOLATED_INVOCATION')
    contract = read(QA + 'CONTRACT.md')
    need(sha(contract) == CONTRACT_SHA, 'FINAL_CONTRACT_HASH')
    need(sha(read(QA + 'CONTRACT.initial-48836e54.md')) == ORIGINAL_SHA, 'ORIGINAL_CONTRACT_HASH')
    pins = dict(re.findall(r'\| `([^\x60]+)` \| `([a-f0-9]{64})` \|', contract.decode()))
    need(len(pins) == 16 and PRODUCTION <= set(pins), 'CONTRACT_INPUT_SET')
    baseline = {}
    for path, digest in pins.items():
        original = git('show', BASE + ':' + path)
        need(sha(original) == digest, 'BASELINE_INPUT_HASH')
        if path in PRODUCTION:
            baseline[path] = original.decode()
        else:
            need(sha(read(path)) == digest, 'UNCHANGED_INPUT_HASH')
    expected = {CONTROLLER: controller_transform(baseline[CONTROLLER]),
                ROUTES: routes_transform(baseline[ROUTES])}
    current = {path: read(path).decode() for path in PRODUCTION}
    need(accepted(current, expected), 'EXACT_DEPENDENTS_AMENDMENT_REQUIRED')
    need(not accepted(baseline, expected), 'BASELINE_NOT_REJECTED')
    changed = set(git('diff', '--name-only', BASE, '--').decode().splitlines())
    untracked = set(git('ls-files', '--others', '--exclude-standard').decode().splitlines())
    ignored = set(git('ls-files', '--others', '--ignored', '--exclude-standard').decode().splitlines())
    need(all(path in PRODUCTION or path.startswith(QA) for path in changed | untracked | ignored), 'WHOLE_TREE_SCOPE')
    need({path for path in changed if path.startswith('src1/')} == PRODUCTION, 'TWO_FILE_PRODUCTION_SCOPE')
    for path in PRODUCTION:
        mode = git('ls-tree', BASE, '--', path).split()[0]
        need(mode == b'100644' and not (ROOT / path).stat().st_mode & 0o111, 'PRODUCTION_MODE')
    controls = []

    def mutate(name, path, before, after):
        variant = dict(expected)
        variant[path] = once(variant[path], before, after)
        need(not accepted(variant, expected), 'SOURCE_CONTROL_SURVIVED')
        controls.append({'id': name, 'status': 'REJECTED_AS_EXPECTED'})

    mutate('router-admission-removed', ROUTES, 'dependentRouter.use(dependentController.authorize);', '')
    late_router = once(expected[ROUTES], 'dependentRouter.use(dependentController.authorize);', '')
    late_router = once(late_router, 'export default dependentRouter;',
                       'dependentRouter.use(dependentController.authorize);\n\nexport default dependentRouter;')
    mutate('router-admission-after-registration', ROUTES, expected[ROUTES], late_router)
    mutate('missing-principal-check', CONTROLLER,
           "!actor || typeof actor._id !== 'string' || actor._id.trim().length === 0", 'false')
    mutate('blank-principal-accepted', CONTROLLER, "actor._id.trim().length === 0", "actor._id.length === 0")
    mutate('principal-coercion', CONTROLLER, "typeof actor._id !== 'string'", "typeof String(actor._id) !== 'string'")
    mutate('role-check-removed', CONTROLLER, "actor.userType !== 'user' && actor.userType !== 'admin'", 'false')
    mutate('hr-admitted', CONTROLLER, "actor.userType !== 'user' && actor.userType !== 'admin'",
           "actor.userType !== 'user' && actor.userType !== 'admin' && actor.userType !== 'hr'")
    mutate('admin-case-folded', CONTROLLER, "if (actor.userType === 'admin')", "if (actor.userType.toLowerCase() === 'admin')")
    mutate('owner-mismatch-check-removed', CONTROLLER,
           'requestedOwner !== undefined && requestedOwner !== actor._id', 'false')
    mutate('ordinary-owner-from-query', CONTROLLER, '    return actor._id;', '    return requestedOwner;')
    mutate('create-mismatch-ignored', CONTROLLER, "actor.userType === 'user' && req.body.userId !== actor._id", 'false')
    mutate('create-owner-request-selected', CONTROLLER,
           "userId: actor.userType === 'admin' ? req.body.userId : actor._id,", 'userId: req.body.userId,')
    mutate('create-spread-overrides-owner', CONTROLLER,
           "      ...req.body,\n      userId: actor.userType === 'admin' ? req.body.userId : actor._id,",
           "      userId: actor.userType === 'admin' ? req.body.userId : actor._id,\n      ...req.body,")
    mutate('admin-on-behalf-removed', CONTROLLER,
           "userId: actor.userType === 'admin' ? req.body.userId : actor._id,", 'userId: actor._id,')
    mutate('list-unscoped', CONTROLLER,
           'const effectiveUserId = this.resolveOwner(req, req.query.userId as string | undefined);',
           'const effectiveUserId = undefined;')
    for method, call in [('getById', 'getById(id, userId)'), ('update', 'update(id, data, userId)'), ('delete', 'delete(id, userId)')]:
        mutate(method + '-unscoped', CONTROLLER, 'this.dependentService.' + call,
               'this.dependentService.' + call.replace(', userId)', ')'))
    for method in ['getByUserId', 'getActiveDependents']:
        mutate(method + '-path-owner-trusted', CONTROLLER,
               'this.dependentService.' + method + '(userId)', 'this.dependentService.' + method + '(req.params.userId)')
    mutate('raw-owner-detection-removed', CONTROLLER,
           "Object.prototype.hasOwnProperty.call(req.body ?? {}, 'userId')", 'false')
    mutate('raw-null-owner-ignored', CONTROLLER,
           "Object.prototype.hasOwnProperty.call(req.body ?? {}, 'userId')", 'Boolean(req.body?.userId)')
    mutate('raw-owner-object-check-removed', CONTROLLER,
           '      await this.dependentService.getById(req.params.id, userId);', '')
    mutate('raw-owner-object-check-unscoped', CONTROLLER,
           'this.dependentService.getById(req.params.id, userId)', 'this.dependentService.getById(req.params.id)')
    mutate('raw-owner-preflight-removed', ROUTES,
           '  catchAsync(dependentController.rejectOwnershipChange),\n', '')
    mutate('raw-owner-preflight-after-strip', ROUTES,
           "  catchAsync(dependentController.rejectOwnershipChange),\n  validate(updateDependentSchema, 'body'),",
           "  validate(updateDependentSchema, 'body'),\n  catchAsync(dependentController.rejectOwnershipChange),")
    mutate('raw-owner-query-before-validation', ROUTES,
           "  validate(dependentQuerySchema, 'query'),\n  catchAsync(dependentController.rejectOwnershipChange),",
           "  catchAsync(dependentController.rejectOwnershipChange),\n  validate(dependentQuerySchema, 'query'),")
    mutate('missing-principal-wrong-error', CONTROLLER, "        code: 'UNAUTHORIZED',", "        code: 'FORBIDDEN',")
    mutate('raw-owner-wrong-error', CONTROLLER,
           "        code: 'FORBIDDEN_FIELD',\n        message: 'Dependent ownership cannot be changed through this endpoint',",
           "        code: 'USER_ID_REQUIRED',\n        message: 'Dependent ownership cannot be changed through this endpoint',")
    return {'schema': 'SD-DEPENDENTS-SOURCE-1', 'status': 'SOURCE_TRANSFORMATION_VERIFIED_RUNTIME_NOT_RUN',
            'baseline': BASE, 'contractSha': CONTRACT_SHA, 'originalContractSha': ORIGINAL_SHA,
            'productionSha': {path: sha(read(path)) for path in sorted(PRODUCTION)},
            'verifierSha': sha(Path(__file__).read_bytes()), 'baselineRejection': 'REJECTED_AS_EXPECTED',
            'negativeSourceControls': controls, 'runtimeHTTP': 'NOT_RUN', 'applicationEvaluations': 0,
            'compilerExecutions': 0, 'databaseCalls': 0, 'providerCalls': 0, 'DockerCalls': 0}


if __name__ == '__main__':
    try:
        print(json.dumps(run(), indent=2))
    except RuntimeError as error:
        print(json.dumps({'schema': 'SD-DEPENDENTS-SOURCE-1', 'status': 'REJECTED', 'code': str(error)}))
        sys.exit(1)

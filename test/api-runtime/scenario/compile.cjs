'use strict';
// Invoked only by the separately reviewed public-preparation step. Never require app code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const requireThat = (ok, code) => { if (!ok) throw new Error(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const once = (text, before, after) => {
  requireThat(text.split(before).length === 2, 'MUTANT_SOURCE_SHAPE');
  return text.replace(before, after);
};

function assertModelDeclarations(declarations, models) {
  const select = rows => rows.map(row => ({ name: row.name, source: row.source }))
    .sort((a, b) => a.name.localeCompare(b.name));
  requireThat(Array.isArray(models) && models.length > 0
    && new Set(models.map(row => row.name)).size === models.length, 'DUPLICATE_DECLARED_MODEL');
  requireThat(new Set(declarations.map(row => row.name)).size === declarations.length, 'DUPLICATE_EMITTED_MODEL');
  requireThat(JSON.stringify(select(declarations)) === JSON.stringify(select(models)), 'EMITTED_MODEL_MANIFEST_MISMATCH');
}

// Parse emitted nominal CommonJS as data. Follow actual literal require edges,
// including erased-import differences, without requiring any domain module.
function inspectEmittedModels(runtimeRoot, modules, ports) {
  const excluded = new Set([...Object.keys(ports.excludedCapabilities), ...ports.recordingModules]);
  const reachable = new Set(); const declarations = []; const queue = ports.roots.map(alias => modules[alias]);
  const sourceFor = file => 'src1/' + file.slice('compiled/'.length, -3) + '.ts';
  const unwrap = expression => {
    while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) return unwrap(expression.right);
    return expression;
  };
  function requiredName(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      requireThat(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]), 'DYNAMIC_DOMAIN_REQUIRE');
      return node.arguments[0].text;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && ['__importDefault', '__importStar'].includes(node.expression.text) && node.arguments.length === 1)
      return requiredName(node.arguments[0]);
    return undefined;
  }
  while (queue.length) {
    const file = queue.shift(); if (reachable.has(file)) continue;
    requireThat(typeof file === 'string' && file.startsWith('compiled/') && !file.startsWith('compiled/mutants/'), 'MODEL_AUDIT_SOURCE');
    reachable.add(file);
    const ast = ts.createSourceFile(file, fs.readFileSync(path.join(runtimeRoot, file), 'utf8'), ts.ScriptTarget.ES2020, true, ts.ScriptKind.JS);
    const mongooseBindings = new Set();
    function bindings(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && requiredName(node.initializer) === 'mongoose') mongooseBindings.add(node.name.text);
      ts.forEachChild(node, bindings);
    }
    bindings(ast);
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const request = requiredName(node);
        if (request && !excluded.has(request)) {
          if (request.startsWith('@/')) { requireThat(modules[request], 'MODEL_AUDIT_UNKNOWN_ALIAS'); queue.push(modules[request]); }
          else if (request.startsWith('.')) {
            const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), request));
            const target = [base + '.js', base + '/index.js'].find(candidate => Object.values(modules).includes(candidate));
            requireThat(target, 'MODEL_AUDIT_UNKNOWN_RELATIVE'); queue.push(target);
          }
        }
        const expression = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'model' && node.arguments.length >= 2) {
          let receiver = expression.expression;
          if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'default') receiver = receiver.expression;
          if (ts.isIdentifier(receiver) && mongooseBindings.has(receiver.text)) {
            requireThat(ts.isStringLiteralLike(node.arguments[0]), 'DYNAMIC_MODEL_DECLARATION');
            declarations.push({ name: node.arguments[0].text, source: sourceFor(file), compiled: file });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  declarations.sort((a, b) => a.name.localeCompare(b.name));
  assertModelDeclarations(declarations, ports.models);
  // Genuine guard sensitivity runs only in the separately approved compiler
  // invocation. These variants change metadata, never production source or DB.
  const controls = [];
  const expectRejected = (id, candidate) => {
    let rejected = false; try { assertModelDeclarations(declarations, candidate); } catch { rejected = true; }
    requireThat(rejected, 'MODEL_AUDIT_CONTROL_SURVIVED'); controls.push({ id, rejected: true });
  };
  expectRejected('OMITTED_WELLNESS_PACKAGE', ports.models.filter(row => row.name !== 'WellnessPackage'));
  expectRejected('EXTRA_UNREACHABLE_MODEL', [...ports.models, { name: 'UnreachableFixtureModel', source: 'src1/unreachable.ts' }]);
  expectRejected('DUPLICATE_MODEL', [...ports.models, ports.models[0]]);
  expectRejected('WRONG_MODEL_SOURCE', ports.models.map((row, index) => index === 0 ? { ...row, source: 'src1/wrong.ts' } : row));
  return { declarations, audit: { status: 'STATIC_EMITTED_MODEL_MAP_VERIFIED', reachableModules: reachable.size,
    modelCount: declarations.length, controls, applicationEvaluations: 0 } };
}

function compile(sourceRoot, runtimeRoot, inputPlan) {
  const ports = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'ports-manifest.json'), 'utf8'));
  const tracked = new Set(inputPlan.trackedSources);
  const excluded = new Set([...Object.keys(ports.excludedCapabilities), ...ports.recordingModules]);
  const modules = {}; const sources = {}; const queue = [...ports.roots];
  const diagnostics = [];
  const externalRoots = new Set(Object.keys(inputPlan.packageVersions));
  function resolveAlias(request, from) {
    if (excluded.has(request)) return null;
    let relative;
    if (request.startsWith('@/')) relative = 'src1/' + request.slice(2);
    else if (request.startsWith('.')) relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
    else return null;
    requireThat(relative.startsWith('src1/') && !relative.includes('..'), 'SOURCE_ESCAPE');
    const found = [relative + '.ts', relative + '/index.ts'].find(name => tracked.has(name));
    requireThat(found, 'UNRESOLVED_SOURCE:' + relative);
    return found;
  }
  function emit(relative, text, output) {
    const result = ts.transpileModule(text, {
      fileName: relative,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
        experimentalDecorators: true, emitDecoratorMetadata: true,
        esModuleInterop: true, importHelpers: false, sourceMap: false,
      },
    });
    for (const item of result.diagnostics || []) diagnostics.push({ file: relative, code: item.code, category: item.category,
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n') });
    requireThat(!(result.diagnostics || []).some(item => item.category === ts.DiagnosticCategory.Error), 'TRANSPILATION_DIAGNOSTIC');
    fs.mkdirSync(path.dirname(path.join(runtimeRoot, output)), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, output), result.outputText);
  }
  while (queue.length) {
    const item = queue.shift();
    if (excluded.has(item)) continue;
    const relative = item.startsWith('src1/') ? item : resolveAlias(item, 'src1/index.ts');
    requireThat(relative, 'UNDECLARED_SOURCE_ROOT');
    if (sources[relative]) continue;
    const absolute = path.join(sourceRoot, relative);
    const metadata = fs.lstatSync(absolute);
    requireThat(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, 'NONREGULAR_SOURCE');
    const bytes = fs.readFileSync(absolute); const text = bytes.toString('utf8');
    const output = 'compiled/' + relative.slice(5, -3) + '.js';
    sources[relative] = sha(bytes);
    const alias = '@/' + relative.slice(5, -3).replace(/\/index$/, '');
    modules[alias] = output;
    modules['@/' + relative.slice(5, -3)] = output;
    const ast = ts.createSourceFile(relative, text, ts.ScriptTarget.ES2020, true);
    for (const statement of ast.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
        const request = statement.moduleSpecifier.text;
        if (excluded.has(request)) continue;
        if (request.startsWith('@/') || request.startsWith('.')) queue.push(resolveAlias(request, relative));
        else if (!request.startsWith('node:') && !['crypto', 'path', 'fs', 'stream', 'util'].includes(request)) {
          const root = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0];
          requireThat(externalRoots.has(root), 'UNREVIEWED_PACKAGE:' + root);
        }
      }
    }
    emit(relative, text, output);
  }
  const modelMap = inspectEmittedModels(runtimeRoot, modules, ports);
  const mutants = {};
  function mutate(id, relative, transform) {
    const original = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
    const changed = transform(original);
    requireThat(changed !== original, 'EMPTY_MUTANT');
    const output = 'compiled/mutants/' + id + '.js';
    emit(relative, changed, output);
    mutants[id] = { source: relative, originalSha256: sources[relative], mutantSha256: sha(Buffer.from(changed)), file: output };
  }
  mutate('OTP_UNCONDITIONAL_CONSUME', 'src1/modules/otp/repository/index.ts', text => once(text, `      {
        _id: otpId,
        userId: data.userId,
        otp: data.otp,
        target: data.target,
        targetValue: data.targetValue,
        isVerified: false,
        expireAt: { $eq: observedExpiry, $gt: consumeCheckpoint },
      },`, '      { _id: otpId },'));
  mutate('OTP_LOGIN_TARGET_UNBOUND', 'src1/modules/auth/services/index.ts', text => {
    const start = text.indexOf("    // Verify OTP against the selected identity's current destination.");
    const end = text.indexOf('    // Create wallet for regular users', start);
    requireThat(start > 0 && end > start, 'LOGIN_MUTANT_BOUNDARY');
    return text.slice(0, start) + once(text.slice(start, end), '      target,\n      targetValue,\n    });', '      target,\n    });') + text.slice(end);
  });
  mutate('USER_OTHER_READ', 'src1/modules/user/controller/index.ts', text => {
    const ast = ts.createSourceFile('user.ts', text, ts.ScriptTarget.ES2020, true);
    const klass = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name.text === 'UserController');
    const method = klass.members.find(member => member.name && member.name.getText(ast) === 'assertUserRouteActor');
    requireThat(method && method.body, 'USER_MUTANT_BOUNDARY');
    return text.slice(0, method.body.pos) + ' { return; }' + text.slice(method.body.end);
  });
  mutate('WALLET_OTHER_READ', 'src1/modules/wallet/controller/index.ts', text => {
    const ast = ts.createSourceFile('wallet.ts', text, ts.ScriptTarget.ES2020, true);
    const klass = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name.text === 'WalletController');
    const member = klass.members.find(property => property.name && property.name.getText(ast) === 'getById');
    const remove = member.initializer.body.statements.filter(statement => ts.isIfStatement(statement));
    requireThat(remove.length === 2, 'WALLET_MUTANT_BOUNDARY');
    for (const statement of remove.reverse()) text = text.slice(0, statement.pos) + text.slice(statement.end);
    return text;
  });
  // Retain focused semantic diagnostics without evaluating any application
  // module or resolving excluded capabilities into the rest of the monolith.
  // Missing declarations/excluded types remain visible diagnostic failures.
  const options = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true, noEmit: true,
    skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const fileExists = host.fileExists; const readFile = host.readFile;
  const sourcePaths = new Set(Object.keys(sources).map(name => path.join(sourceRoot, name)));
  const typeRoot = path.join(runtimeRoot, 'node_modules') + path.sep;
  const allowedTypeFile = file => sourcePaths.has(path.resolve(file)) || path.resolve(file).startsWith(typeRoot);
  host.fileExists = file => allowedTypeFile(file) && fileExists(file);
  host.readFile = file => allowedTypeFile(file) ? readFile(file) : undefined;
  host.getSourceFile = (file, languageVersion, onError) => {
    const text = host.readFile(file);
    if (text === undefined) { if (onError) onError('DECLARED_TYPE_INPUT_UNAVAILABLE'); return undefined; }
    return ts.createSourceFile(file, text, languageVersion, true);
  };
  host.getCurrentDirectory = () => runtimeRoot;
  host.getDefaultLibFileName = () => path.join(typeRoot, 'typescript/lib/lib.es2020.full.d.ts');
  host.resolveModuleNames = (names, containingFile) => names.map(request => {
    if (excluded.has(request)) return undefined;
    if (sourcePaths.has(containingFile) && (request.startsWith('@/') || request.startsWith('.'))) {
      const relative = resolveAlias(request, path.relative(sourceRoot, containingFile).split(path.sep).join('/'));
      const absolute = relative && path.join(sourceRoot, relative);
      requireThat(sourcePaths.has(absolute), 'SEMANTIC_SOURCE_OUTSIDE_CLOSURE');
      return { resolvedFileName: absolute, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    const from = sourcePaths.has(containingFile) ? path.join(runtimeRoot, '__public_types__.ts') : containingFile;
    return ts.resolveModuleName(request, from, options, host).resolvedModule;
  });
  const program = ts.createProgram([...sourcePaths], options, host);
  const semanticDiagnostics = ts.getPreEmitDiagnostics(program).map(item => ({
    file: item.file ? path.relative(sourceRoot, item.file.fileName).split(path.sep).join('/') : null,
    code: item.code, category: item.category, message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
  }));
  const plan = { schema: 'SD-AUTH-API-PLAN-1', role: ports.role, sourceCommit: inputPlan.sourceCommit, sourceFiles: sources,
    modules, mutants, models: ports.models, modelDeclarations: modelMap.declarations, modelMapAudit: modelMap.audit,
    packageVersions: inputPlan.packageVersions, lockSha: inputPlan.lockSha,
    portsSha: inputPlan.portsSha, requiredCaseIds: ports.requiredCaseIds,
    requiredSensitivityIds: ports.requiredSensitivityIds, providerCounterKeys: ports.providerCounterKeys,
    providerCounterScope: 'NOMINAL_ONLY_EXCLUDING_EXPLICIT_SENSITIVITY_PHASES',
    compilation: { status: 'TRANSPILE_ONLY_NOT_TYPECHECKED', compiler: ts.version, diagnostics,
      semanticDiagnostics, semanticScope: 'DECLARED_CLOSURE_AND_PUBLIC_TYPES_WITH_EXCLUDED_CAPABILITIES_UNRESOLVED', fullBuild: false } };
  fs.writeFileSync(path.join(runtimeRoot, 'runtime-plan.json'), JSON.stringify(plan, null, 2) + '\n');
  return plan;
}

if (require.main === module) {
  requireThat(process.argv.length === 5, 'COMPILER_INVOCATION');
  const input = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
  compile(process.argv[2], process.argv[3], input);
}
module.exports = { compile };

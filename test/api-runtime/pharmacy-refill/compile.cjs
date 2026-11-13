'use strict';
// Preparation only. Compiler sees complete reviewed sources as data; no package/domain evaluation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const NativeModule = require('node:module');
if (!NativeModule.builtinModules.includes('punycode')) throw Error('PUNYCODE_NATIVE_PROFILE');
const ts = require('typescript');
const [inputPath, runtime] = process.argv.slice(2);
const need = (ok, code) => { if (!ok) throw Error(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
need(process.argv.length === 4 && ts.version === '5.9.3', 'FIXED_COMPILER');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const { ports, sources } = input;
need(sha(fs.readFileSync(path.join(__dirname, 'disabled-express-template.cjs'))) === ports.disabledExpressTemplateHelperSha256, 'TEMPLATE_HELPER_SOURCE');
const { EXPRESS_VIEW_POLICY, EXPRESS_VIEW_POLICY_SHA256, matchDisabledExpressViewSite } = require('./disabled-express-template.cjs');
need(EXPRESS_VIEW_POLICY_SHA256 === ports.disabledExpressTemplatePolicySha256, 'TEMPLATE_POLICY_BINDING');
need(Object.keys(sources).length === 19 && ports.requiredCaseIds.length === 20 && ports.requiredSensitivityIds.length === 7, 'FIXED_SOURCE_COUNTS');
for (const [id, digest] of Object.entries(ports.sourcePins)) need(sha(sources[id]) === digest, 'SOURCE_PIN');
const phases = { nominal: sources }; const mutations = {};
for (const id of ports.requiredSensitivityIds) {
  const recipe = ports.mutationRecipes[id]; need(recipe && recipe.changes.length > 0, 'CONTROL_RECIPE');
  const changed = { ...sources };
  for (const edit of recipe.changes) {
    need(Object.hasOwn(changed, edit.path) && typeof edit.before === 'string' && edit.before.length > 0 &&
      changed[edit.path].split(edit.before).length === edit.count + 1 && Number.isSafeInteger(edit.count) && edit.count > 0, 'EXACT_CONTROL_TARGET');
    changed[edit.path] = changed[edit.path].split(edit.before).join(edit.after);
  }
  const files = Object.keys(changed).filter(name => changed[name] !== sources[name]); need(files.length > 0, 'CONTROL_EMPTY');
  need(Object.keys(recipe.expectedSourceHashes).sort().join() === files.sort().join() && files.every(name => sha(changed[name]) === recipe.expectedSourceHashes[name]), 'CONTROL_RESULT_PIN');
  mutations[id] = { predicate: recipe.predicate, files: Object.fromEntries(files.map(name => [name, {
    beforeSha256: sha(sources[name]), afterSha256: sha(changed[name]), before: sources[name], after: changed[name],
  }])) };
  phases[id] = changed;
}
const libraries = path.dirname(require.resolve('typescript'));
const compilation = {}; const modules = {}; const libraryReads = {};
function local(from, spec) {
  const base = spec.startsWith('@/') ? 'src1/' + spec.slice(2) : spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)) : null;
  return base ? [base + '.ts', base + '/index.ts'].find(name => Object.hasOwn(sources, name)) : undefined;
}
const unreachableComputedEdges=[], unreachableComputedNegativeChecks=[];
function disabledComputed(node,tree,filename,digest) {
  const policy=ports.unreachableComputedEdge;
  if(filename!==policy.parent||digest!==policy.parentSha256||!ts.isCallExpression(node)||!ts.isIdentifier(node.expression)||node.expression.text!=='require'||node.arguments.length!==1||ts.isStringLiteral(node.arguments[0])||node.getText(tree)!==policy.expression)return false;
  let parent=node.parent,branch,fn;while(parent&&!ts.isSourceFile(parent)){if(!branch&&ts.isIfStatement(parent))branch=parent;if(ts.isFunctionDeclaration(parent)){fn=parent;break;}parent=parent.parent;}
  return !!branch&&!!fn&&fn.name?.text===policy.functionName&&branch.thenStatement.pos<=node.pos&&branch.thenStatement.end>=node.end&&branch.expression.getText(tree).replace(/\s+/g,'')===policy.guard.replace(/\s+/g,'');
}
function computedNodes(tree){const found=[];const walk=node=>{if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'&&(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0])))found.push(node);ts.forEachChild(node,walk);};walk(tree);return found;}
function proveDisabledPolicy(code,tree,node,filename){
  const policy=ports.unreachableComputedEdge,digest=sha(code);need(computedNodes(tree).length===1&&disabledComputed(node,tree,filename,digest),'UNIQUE_DISABLED_COMPUTED_EDGE');
  const changedGuard=code.replace('MONGODB_CLIENT_ENCRYPTION_OVERRIDE.length > 0','MONGODB_CLIENT_ENCRYPTION_OVERRIDE.length >= 0');
  const changedCall=code.replace(policy.expression,policy.expression.replace(')'," + '')"));
  const variants=[['wrong-parent',tree,node,filename+'.other',digest],['wrong-hash',tree,node,filename,'0'.repeat(64)]];
  for(const [name,text]of[['wrong-guard',changedGuard],['wrong-expression',changedCall]]){need(text!==code,'NEGATIVE_POLICY_CHANGE');const parsed=ts.createSourceFile(filename,text,ts.ScriptTarget.ES2022,true),nodes=computedNodes(parsed);need(nodes.length===1,'NEGATIVE_POLICY_AST');variants.push([name,parsed,nodes[0],filename,digest]);}
  for(const [id,parsed,call,parent,hash]of variants){need(!disabledComputed(call,parsed,parent,hash),'DISABLED_POLICY_NEGATIVE');unreachableComputedNegativeChecks.push({id,detected:true});}
  unreachableComputedEdges.push({...policy,start:node.getStart(tree),length:node.getWidth(tree)});
}
const disabledExpressTemplateSites = [], disabledExpressTemplateNegativeChecks = [];
function proveDisabledExpressTemplate(code, tree, node, filename) {
  const policy = EXPRESS_VIEW_POLICY, digest = sha(code);
  need(disabledExpressTemplateSites.length === 0 && matchDisabledExpressViewSite(ts, tree, node, filename, digest), 'TEMPLATE_SINGLE_SITE');
  const replaceOne = (text, before, after) => { need(before.length > 0 && text.split(before).length === 2, 'TEMPLATE_NEGATIVE_TARGET'); return text.replace(before, after); };
  const declaration = 'function ' + policy.functionName + '(' + policy.functionParameters.join(', ') + ')';
  const expression = 'var ' + policy.resultBinding + ' = ' + policy.containingExpression;
  const earlyExport = replaceOne(replaceOne(code, policy.moduleExport + ';', ''), "'use strict';", "'use strict';\n" + policy.moduleExport + ';');
  const variants = [
    ['wrong-parent-path', code, filename + '.other', digest],
    ['wrong-parent-hash', code, filename, '0'.repeat(64)],
    ['wrong-View-function-or-params', replaceOne(code, declaration, declaration.replace(policy.functionName, 'OtherView')), filename, digest],
    ['wrong-engine-guard', replaceOne(code, policy.guard, '!!opts.engines[this.ext]'), filename, digest],
    ['wrong-require-or-__express-expression', replaceOne(code, policy.containingExpression, policy.expression + '.render'), filename, digest],
    ['wrong-mod-target-declaration', replaceOne(code, policy.targetDeclaration, 'var mod = this.ext.slice(2)'), filename, digest],
    ['moved-to-top-level-or-export-before-three-imports', earlyExport, filename, digest],
    ['duplicate-computed-site-or-incoming-view-edge', replaceOne(code, expression, expression + ';\n    ' + expression), filename, digest],
  ];
  for (const [id, changed, parent, hash] of variants) {
    const parsed = ts.createSourceFile(parent, changed, ts.ScriptTarget.ES2022, true), nodes = computedNodes(parsed);
    need(nodes.length > 0 && nodes.every(call => !matchDisabledExpressViewSite(ts, parsed, call, parent, hash)), 'TEMPLATE_NEGATIVE_UNDETECTED');
    disabledExpressTemplateNegativeChecks.push({ id, detected: true });
  }
  disabledExpressTemplateSites.push({ parent: policy.parent, parentSha256: digest, entryParent: policy.entryParent,
    entryParentSha256: policy.entryParentSha256, start: node.getStart(tree), length: node.getWidth(tree),
    canonicalPolicySha256: EXPRESS_VIEW_POLICY_SHA256, negativeChecks: disabledExpressTemplateNegativeChecks });
}
function edges(code, filename) {
  const result = new Set(); const tree = ts.createSourceFile(filename, code, ts.ScriptTarget.ES2022, true);
  const walk = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      if(node.arguments.length===1&&ts.isStringLiteral(node.arguments[0]))result.add(node.arguments[0].text);
      else if (matchDisabledExpressViewSite(ts, tree, node, filename, sha(code))) proveDisabledExpressTemplate(code, tree, node, filename);
      else{need(disabledComputed(node,tree,filename,sha(code)),'COMPUTED_REQUIRE');proveDisabledPolicy(code,tree,node,filename);}
    }
    need(!(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword), 'DYNAMIC_IMPORT');
    ts.forEachChild(node, walk);
  }; walk(tree); return [...result];
}
const builtinNames = new Set(['assert','async_hooks','buffer','crypto','dns','events','fs','http','https','net','os','path','perf_hooks','process','punycode','querystring','stream','string_decoder','timers','tls','tty','url','util','zlib']);
for (const [phase, texts] of Object.entries(phases)) {
  const emitted = {}; const reads = {};
  const read = name => {
    if (name.startsWith('/closed/')) return texts[name.slice(8)];
    if (path.dirname(name) === libraries && /^lib\.[A-Za-z0-9.]+\.d\.ts$/.test(path.basename(name))) {
      const st = fs.lstatSync(name); need(st.isFile() && !st.isSymbolicLink(), 'LIBRARY_SHAPE');
      const data = fs.readFileSync(name, 'utf8'); reads[path.basename(name)] = sha(data); return data;
    }
    return undefined;
  };
  const host = {
    getSourceFile(name, lang) { const code = read(name); return code === undefined ? undefined : ts.createSourceFile(name, code, lang, true); },
    getDefaultLibFileName: () => path.join(libraries, 'lib.es2022.full.d.ts'),
    writeFile(name, text) { need(name.startsWith('/closed/') && name.endsWith('.js'), 'EMIT_PATH'); emitted[name.slice(8).replace(/\.js$/, '.ts')] = text; },
    getCurrentDirectory: () => '/closed', getDirectories: () => [], fileExists: name => read(name) !== undefined, readFile: read,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    directoryExists: name => name === '/closed' || name === libraries,
  };
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
    emitDecoratorMetadata: true, esModuleInterop: true, skipLibCheck: true, noEmitOnError: false, types: [] };
  const program = ts.createProgram(Object.keys(texts).map(name => '/closed/' + name), options, host);
  need(program.getSyntacticDiagnostics().length === 0, 'SYNTAX_DIAGNOSTIC'); const result = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics).map(d => ({ file: d.file?.fileName.replace('/closed/', '') ?? null,
    code: d.code, category: d.category, start: d.start ?? null, length: d.length ?? null, message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
  const captured = JSON.stringify({ phase, captureStatus: 'COMPLETE', compiler: ts.version, diagnostics });
  need(diagnostics.length <= 8192 && Buffer.byteLength(captured) <= 4 * 1024 * 1024, 'DIAGNOSTIC_CAPTURE_BOUND');
  fs.writeFileSync(path.join(runtime, 'diagnostics-' + phase + '.json'), captured + '\n', { flag: 'wx', mode: 0o600 });
  need(!result.emitSkipped && Object.keys(emitted).sort().join() === Object.keys(texts).sort().join(), 'WHOLE_EMISSION_INCOMPLETE');
  const map = {}; const imports = {};
  for (const [id, code] of Object.entries(emitted)) {
    const filename = 'compiled/' + phase + '/' + id.replace(/\.ts$/, '.js'); fs.mkdirSync(path.dirname(path.join(runtime, filename)), { recursive: true });
    fs.writeFileSync(path.join(runtime, filename), code, { flag: 'wx', mode: 0o444 }); map[id] = filename; imports[id] = {};
    for (const spec of edges(code, id)) {
      const target = local(id, spec); const native = spec.replace(/^node:/, '');
      need(target || ports.cuts.some(cut => cut.specifier === spec) || ports.runtimeRoots.includes(spec) || builtinNames.has(native), 'APPLICATION_IMPORT_CLOSURE');
      imports[id][spec] = target ?? spec;
    }
  }
  const modelNames = Object.entries(texts).flatMap(([source, text]) => [...text.matchAll(/\bmodel(?:<[^;]+?>)?\(\s*['"]([^'"]+)['"]/g)].map(m => ({ source, name: m[1] })));
  need(modelNames.length === 2 && modelNames.every(model => ports.models.some(actual => actual.name === model.name && actual.source === model.source)), 'MODEL_CLOSURE');
  modules[phase] = map; compilation[phase] = { sources: Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, sha(text)])), edges: imports,
    emittedCount: 19, diagnostics, status: 'TRANSPILE_ONLY_NOT_TYPECHECKED' }; libraryReads[phase] = reads;
}
// Audited literal package resolution stays inside this owned install, never evaluates a package.
const project = path.dirname(require.resolve('typescript/package.json')).replace(/\/node_modules\/typescript$/, '');
const packageFiles = {}; const packageEdges = {}; const packageRoots = {}; const optional = []; const natives = new Set();
function packageFile(filename) {
  const relative = path.relative(project, filename).split(path.sep).join('/');
  need(relative.startsWith('node_modules/') && !relative.includes('../') && /\.(js|json|cjs)$/.test(relative), 'PACKAGE_PATH');
  const st = fs.lstatSync(filename); need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 4 * 1024 * 1024, 'PACKAGE_FILE'); return relative;
}
function resolveFile(from, spec) {
  need(!path.isAbsolute(spec) && !/[\\\0]/.test(spec), 'PACKAGE_SPECIFIER'); const candidates = [];
  if (spec.startsWith('.')) candidates.push(path.resolve(path.dirname(from), spec));
  else {
    need(/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(spec), 'PACKAGE_SPECIFIER');
    let current = path.dirname(from);
    while (current === project || current.startsWith(project + '/')) { candidates.push(path.join(current, 'node_modules', spec)); const next = path.dirname(current); if (next === current) break; current = next; }
  }
  for (const base of candidates) {
    for (const filename of [base, base + '.js', base + '.json', base + '.cjs']) if (fs.existsSync(filename) && fs.lstatSync(filename).isFile()) { packageFile(filename); return filename; }
    const metadata = path.join(base, 'package.json');
    if (fs.existsSync(metadata)) {
      packageFile(metadata); const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8')); const main = path.resolve(base, pkg.main || 'index.js');
      for (const filename of [main, main + '.js', path.join(main, 'index.js')]) if (fs.existsSync(filename) && fs.lstatSync(filename).isFile()) { packageFile(filename); return filename; }
    }
    const index = path.join(base, 'index.js'); if (fs.existsSync(index)) { packageFile(index); return index; }
  }
  const error = Error('Absent package edge'); error.code = 'MODULE_NOT_FOUND'; throw error;
}
function visit(filename) {
  const id = packageFile(filename); if (Object.hasOwn(packageFiles, id)) return id;
  const code = fs.readFileSync(filename, 'utf8'); packageFiles[id] = sha(code); packageEdges[id] = {};
  need(Object.keys(packageFiles).length <= 4096, 'PACKAGE_GRAPH_BOUND');
  if (filename.endsWith('.json')) { JSON.parse(code); return id; }
  for (const spec of edges(code, id)) {
    const native = spec.replace(/^node:/, '');
    if (builtinNames.has(native)) { natives.add(native); packageEdges[id][spec] = 'node:' + native; continue; }
    let resolved;
    try { resolved = resolveFile(filename, spec); }
    catch (error) {
      const tuple = ports.optionalAbsentEdges.find(row => row.parent === id && row.parentSha256 === packageFiles[id] && row.specifier === spec);
      need(error.code === 'MODULE_NOT_FOUND' && tuple, 'UNDECLARED_ABSENT_EDGE');
      optional.push(tuple); packageEdges[id][spec] = 'absent:' + spec; continue;
    }
    packageEdges[id][spec] = visit(resolved);
  }
  return id;
}
for (const name of ports.runtimeRoots) packageRoots[name] = visit(resolveFile(path.join(project, 'entry.js'), name));
for(const [id,digest] of Object.entries(ports.nativeSourcePins)) need(packageFiles[id]===digest,'NATIVE_SOURCE_PROFILE');
need(unreachableComputedEdges.length===1&&unreachableComputedNegativeChecks.length===4,'DISABLED_POLICY_COMPLETENESS');
need(disabledExpressTemplateSites.length === 1 && disabledExpressTemplateNegativeChecks.length === 8, 'TEMPLATE_POLICY_COMPLETENESS');
need(packageFiles[EXPRESS_VIEW_POLICY.parent] === EXPRESS_VIEW_POLICY.parentSha256 && packageFiles[EXPRESS_VIEW_POLICY.entryParent] === EXPRESS_VIEW_POLICY.entryParentSha256, 'TEMPLATE_NATIVE_PARENTS');
const entryCode = fs.readFileSync(path.join(project, EXPRESS_VIEW_POLICY.entryParent), 'utf8');
const entryTree = ts.createSourceFile(EXPRESS_VIEW_POLICY.entryParent, entryCode, ts.ScriptTarget.ES2022, true), incoming = [];
const entryWalk = node => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === EXPRESS_VIEW_POLICY.entrySpecifier) incoming.push(node); ts.forEachChild(node, entryWalk); };
entryWalk(entryTree); need(incoming.length === 1, 'TEMPLATE_INCOMING_EDGE');
for (let parent = incoming[0].parent; parent; parent = parent.parent) need(!ts.isFunctionLike(parent), 'TEMPLATE_INCOMING_TOPLEVEL');

const plan = { schema: 'SD-PHARMACY-REFILL-API-PLAN-1', role: ports.role, sourceCommit: input.sourceCommit, lockSha: input.lockSha,
  portsSha: input.portsSha, sourceFiles: ports.sourcePins, modules, phases: compilation, mutations,
  requiredCaseIds: ports.requiredCaseIds, requiredSensitivityIds: ports.requiredSensitivityIds, providerCounterKeys: ports.providerCounterKeys,
  models: ports.models, packageGraph: { disabledExpressTemplate: disabledExpressTemplateSites[0], files: packageFiles, edges: packageEdges, roots: packageRoots, absentOptional: optional, unreachableComputedEdges, unreachableComputedNegativeChecks, builtins: [...natives].sort() },
  compilation: { status: 'TRANSPILE_ONLY_NOT_TYPECHECKED', compiler: ts.version, compilerSha256: sha(fs.readFileSync(require.resolve('typescript'))), libraryReads }, packageVersions: input.packageVersions };
fs.writeFileSync(path.join(runtime, 'runtime-plan.json'), JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ status: 'PREPARED_NOT_EXECUTED', phases: 8, sources: 19, applicationEvaluations: 0 }) + '\n');

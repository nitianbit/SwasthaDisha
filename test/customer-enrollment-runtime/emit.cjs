'use strict';
// Preparation only. Loads the locked compiler, never emitted application/package modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const [inputPath, outputDirectory] = process.argv.slice(2);
const check = (ok, why) => { if (!ok) throw new Error(why); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
check(process.argv.length === 4 && ts.version === '5.9.3', 'Fixed compiler invocation/version');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const plan = input.plan;
check(plan.schema === 'SD-ENROLLMENT-PORTS-1' && Object.keys(input.sources).length === 6, 'Exact emission input');
for (const [id, expected] of Object.entries(plan.sourcePins)) check(sha(input.sources[id]) === expected, 'Source drift: ' + id);
const serviceId = 'src1/modules/auth/services/index.ts';
const validationId = 'src1/modules/auth/validation/index.ts';
const diagnostics = {}; const reads = {}; const edits = {}; const phases = {}; const diagnosticPolicyProofs = {};
function ast(text, name) { return ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true); }
function walk(node, predicate, found = []) { if (predicate(node)) found.push(node); ts.forEachChild(node, child => { walk(child, predicate, found); }); return found; }
function edit(id, text, predicate, replacement) {
  const source = ast(text, id); const matches = walk(source, predicate);
  check(matches.length === 1, 'Control requires exactly one AST target: ' + id);
  const node = matches[0]; const start = node.getStart(source); const end = node.end;
  const output = text.slice(0, start) + replacement + text.slice(end);
  edits[id] = { start, end, beforeSha256: sha(text), afterSha256: sha(output), removed: text.slice(start, end), inserted: replacement };
  return output;
}
const sourcesByPhase = { nominal: input.sources, OLD: { ...input.sources, ...input.baseline } };
const customerSelector = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'selectCustomerLoginContact';
for (const id of ['NC1', 'NC2', 'NC3', 'NC4']) {
  const sources = { ...input.sources };
  if (id === 'NC1') {
    sources[validationId] = edit(id, sources[validationId], node => ts.isIdentifier(node) && node.text === 'xor'
      && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node, 'or');
  } else if (id === 'NC2' || id === 'NC3') {
    const tree = ast(sources[serviceId], serviceId);
    const members = walk(tree, n => (ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n)) && n.name?.getText() === (id === 'NC2' ? 'sendOTP' : 'verifyOTP'));
    check(members.length === 1, 'Exact service command target');
    const calls = walk(members[0], customerSelector); check(calls.length === 1, 'Exact command selector call');
    const start = calls[0].getStart(tree); const end = calls[0].end;
    const before = sources[serviceId]; sources[serviceId] = before.slice(0, start) + 'undefined' + before.slice(end);
    edits[id] = { start, end, beforeSha256: sha(before), afterSha256: sha(sources[serviceId]), removed: before.slice(start, end), inserted: 'undefined' };
  } else {
    sources[serviceId] = edit(id, sources[serviceId], node => ts.isSpreadAssignment(node) && node.expression.getText().includes('customerIdentity ??'), 'phone: data.phone, email: data.email');
  }
  sourcesByPhase[id] = sources;
}
const diagnosticFiles = Object.freeze({
  nominal: 'diagnostics-nominal.json', OLD: 'diagnostics-OLD.json', NC1: 'diagnostics-NC1.json',
  NC2: 'diagnostics-NC2.json', NC3: 'diagnostics-NC3.json', NC4: 'diagnostics-NC4.json',
});
function captureDiagnostics(phase, sources, returned) {
  check(Object.hasOwn(diagnosticFiles, phase), 'Unknown fixed diagnostic phase');
  let complete = returned.length <= 256 && returned.every(row => Buffer.byteLength(row.message, 'utf8') <= 8192);
  const evidence = {
    schema: 'SD-ENROLLMENT-RETURNED-DIAGNOSTICS-1', phase,
    compiler: { version: ts.version, sha256: sha(fs.readFileSync(require.resolve('typescript'))) },
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([id, text]) => [id, sha(text)])),
    optionsSha256: sha(JSON.stringify(plan.options)), returnedCount: returned.length,
    captureStatus: complete ? 'COMPLETE' : 'LIMIT_EXCEEDED', complete,
    diagnostics: complete ? returned.map(row => ({ file: row.file ?? null, code: row.code, category: row.category,
      start: row.start ?? null, length: row.length ?? null, message: row.message })) : [],
  };
  let bytes = JSON.stringify(evidence) + '\n';
  if (Buffer.byteLength(bytes, 'utf8') > 262144) {
    complete = false; evidence.captureStatus = 'LIMIT_EXCEEDED'; evidence.complete = false; evidence.diagnostics = [];
    bytes = JSON.stringify(evidence) + '\n';
  }
  check(Buffer.byteLength(bytes, 'utf8') <= 262144, 'Diagnostic envelope exceeds fixed bound');
  // Fresh0700 output belongs to prepare.py's inode/marker-owned area; never overwrite a prior phase record.
  fs.writeFileSync(path.join(outputDirectory, diagnosticFiles[phase]), bytes, { flag: 'wx', mode: 0o600 });
  check(complete, 'Returned diagnostics exceed fixed capture limits; review private phase evidence');
}
// One observed missing Node declaration in this pinned emit-only source, never a generic2339 exception.
const nodeDiagnostic = Object.freeze({
  file: 'src1/modules/common/types/error.ts', sourceSha256: '3f69860897913c1d8467e3f8aaca7d083e9d50a841553adce33ec6421a0fda07',
  category: 1, code: 2339, start: 573, length: 17,
  message: "Property 'captureStackTrace' does not exist on type 'ErrorConstructor'.",
});
const nodeDiagnosticFields = Object.freeze(['file', 'category', 'code', 'start', 'length', 'message']);
function exactNodeDiagnostic(row) { return nodeDiagnosticFields.every(key => row[key] === nodeDiagnostic[key]); }
function admittedDiagnostics(returned, sources, imports) {
  if (typeof sources[nodeDiagnostic.file] !== 'string' || sha(sources[nodeDiagnostic.file]) !== nodeDiagnostic.sourceSha256) return false;
  return returned.filter(exactNodeDiagnostic).length === 1 && returned.filter(row => row.code !== 2307).length === 1
    && returned.every(d => (d.code === 2307 && [...imports].some(spec => d.message.includes("'" + spec + "'"))) || exactNodeDiagnostic(d));
}
function proveDiagnosticPolicy(phase, returned, sources, imports) {
  check(admittedDiagnostics(returned, sources, imports), 'Actual returned diagnostic policy positive failed');
  const index = returned.findIndex(exactNodeDiagnostic); const exact = returned[index];
  const negatives = [
    { id: 'missing-tuple', rows: returned.filter((_, i) => i !== index), sources },
    { id: 'duplicate-tuple', rows: [...returned, { ...exact }], sources },
    ...Object.entries({ file: 'src1/modules/common/types/response.ts', category: 0, code: 2307, start: 574, length: 16,
      message: nodeDiagnostic.message + ' ' }).map(([key, value]) => ({ id: 'wrong-' + key,
        rows: returned.map((row, i) => i === index ? { ...row, [key]: value } : row), sources })),
    { id: 'source-hash-drift', rows: returned, sources: { ...sources, [nodeDiagnostic.file]: sources[nodeDiagnostic.file] + '\n' } },
    { id: 'extra-unsupported', rows: [...returned, { ...exact, code: 9999 }], sources },
  ];
  const rejected = [];
  for (const item of negatives) {
    check(!admittedDiagnostics(item.rows, item.sources, imports), 'Diagnostic policy negative accepted: ' + item.id);
    rejected.push({ id: item.id, rejected: true });
  }
  return { schema: 'SD-ENROLLMENT-DIAGNOSTIC-POLICY-PROOF-1', phase, returnedCount: returned.length,
    sourceSha256: sha(sources[nodeDiagnostic.file]), positive: { id: 'actual-returned-set', accepted: true }, negatives: rejected };
}
const libRoot = path.dirname(require.resolve('typescript'));
function compile(phase, sources) {
  const prefix = '/closed/'; const libraryReads = {};
  const read = filename => {
    if (filename.startsWith(prefix)) return sources[filename.slice(prefix.length)];
    if (path.dirname(filename) === libRoot && /^lib\.[A-Za-z0-9.]+\.d\.ts$/.test(path.basename(filename))) {
      const stat = fs.lstatSync(filename); check(stat.isFile() && !stat.isSymbolicLink(), 'Compiler library shape');
      const bytes = fs.readFileSync(filename, 'utf8'); libraryReads[path.basename(filename)] = sha(bytes); return bytes;
    }
    return undefined;
  };
  const emitted = {};
  const host = {
    getSourceFile: (name, language) => { const text = read(name); return text === undefined ? undefined : ts.createSourceFile(name, text, language, true); },
    getDefaultLibFileName: () => path.join(libRoot, 'lib.es2022.full.d.ts'),
    writeFile: (name, text) => { check(name.startsWith(prefix) && name.endsWith('.js'), 'Unexpected emit path'); emitted[name.slice(prefix.length).replace(/\.js$/, '.ts')] = text; },
    getCurrentDirectory: () => '/closed', getDirectories: () => [], fileExists: name => read(name) !== undefined,
    readFile: read, getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    directoryExists: name => name === '/closed' || name === libRoot,
  };
  const program = ts.createProgram(Object.keys(sources).map(id => prefix + id), plan.options, host);
  const result = program.emit();
  diagnostics[phase] = ts.getPreEmitDiagnostics(program).concat(result.diagnostics).map(d => ({
    file: d.file?.fileName?.replace(prefix, ''), code: d.code, category: d.category, start: d.start, length: d.length,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
  captureDiagnostics(phase, sources, diagnostics[phase]);
  check(!result.emitSkipped && Object.keys(emitted).sort().join() === Object.keys(sources).sort().join(), 'Whole-module emission incomplete');
  const imports = new Set(Object.values(sources).flatMap(text => walk(ast(text, 'input.ts'), n => ts.isImportDeclaration(n)
    || ts.isExportDeclaration(n)).map(n => n.moduleSpecifier?.text).filter(Boolean)));
  check(admittedDiagnostics(diagnostics[phase], sources, imports), 'Unexpected compiler diagnostic; exact preparation amendment/review required');
  diagnosticPolicyProofs[phase] = proveDiagnosticPolicy(phase, diagnostics[phase], sources, imports);
  reads[phase] = libraryReads;
  return emitted;
}
const cutIds = new Set(plan.cuts.map(row => row.specifier).concat('@/config/config'));
const actualAlias = spec => spec.startsWith('@/') ? 'src1/' + spec.slice(2) + '/index.ts' : undefined;
function actualResolution(from, spec) {
  if (spec.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec + '.ts'));
  return actualAlias(spec);
}
function requireEdges(code, id) {
  const tree = ast(code, id); const edges = [];
  walk(tree, node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      check(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), 'Dynamic require: ' + id);
      edges.push(node.arguments[0].text);
    }
    check(!(ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword), 'Dynamic import: ' + id);
    return false;
  });
  return [...new Set(edges)].sort();
}
for (const [phase, sources] of Object.entries(sourcesByPhase)) {
  const modules = compile(phase, sources); const edges = {};
  for (const [id, code] of Object.entries(modules)) {
    edges[id] = {};
    for (const spec of requireEdges(code, id)) {
      const target = actualResolution(id, spec);
      check(cutIds.has(spec) || spec === 'node:crypto' || plan.runtimeRoots.includes(spec) || Object.hasOwn(modules, target), 'Unadmitted actual edge: ' + spec);
      edges[id][spec] = cutIds.has(spec) || spec === 'node:crypto' || plan.runtimeRoots.includes(spec) ? spec : target;
    }
  }
  phases[phase] = { modules, edges, sourceHashes: Object.fromEntries(Object.entries(sources).map(([id, text]) => [id, sha(text)])) };
}
// Resolve package files without require/evaluation. Only audited literal CommonJS edges enter runtime.
const project = path.dirname(require.resolve('typescript/package.json')).replace(/\/node_modules\/typescript$/, '');
const packageModules = {}; const packageEdges = {}; const builtins = new Set(); const roots = {};
function safePackageFile(filename) {
  const relative = path.relative(project, filename).split(path.sep).join('/');
  check(relative.startsWith('node_modules/') && !relative.includes('../') && /\.(js|json)$/.test(relative), 'Package file escaped closure');
  const st = fs.lstatSync(filename); check(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 1024 * 1024, 'Unsafe package file');
  return relative;
}
function resolveFile(from, spec) {
  check(!spec.startsWith('/') && !spec.includes('\\') && !spec.includes('\0'), 'Invalid require');
  let candidates = [];
  if (spec.startsWith('.')) candidates.push(path.resolve(path.dirname(from), spec));
  else {
    check(/^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(spec), 'Unadmitted package specifier');
    let current = path.dirname(from);
    while (current.startsWith(project)) { candidates.push(path.join(current, 'node_modules', spec)); const next = path.dirname(current); if (next === current) break; current = next; }
  }
  for (const base of candidates) {
    for (const candidate of [base, base + '.js', base + '.json']) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) { safePackageFile(candidate); return candidate; }
    const metadata = path.join(base, 'package.json');
    if (fs.existsSync(metadata)) {
      safePackageFile(metadata); const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      const main = path.resolve(base, pkg.main || 'index.js');
      for (const candidate of [main, main + '.js', path.join(main, 'index.js')]) if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) { safePackageFile(candidate); return candidate; }
    }
    const index = path.join(base, 'index.js'); if (fs.existsSync(index)) { safePackageFile(index); return index; }
  }
  throw new Error('Unresolved package edge: ' + spec);
}
function visit(filename) {
  const id = safePackageFile(filename); if (Object.hasOwn(packageModules, id)) return id;
  const code = fs.readFileSync(filename, 'utf8'); packageModules[id] = code; packageEdges[id] = {};
  if (filename.endsWith('.json')) { JSON.parse(code); return id; }
  for (const spec of requireEdges(code, id)) {
    const builtin = spec.replace(/^node:/, '');
    if (plan.builtinCandidates.includes(builtin)) { builtins.add(builtin); packageEdges[id][spec] = 'node:' + builtin; }
    else packageEdges[id][spec] = visit(resolveFile(filename, spec));
  }
  return id;
}
for (const name of plan.runtimeRoots) roots[name] = visit(resolveFile(path.join(project, 'entry.js'), name));
const runtime = { schema: 'SD-ENROLLMENT-RUNTIME-MAP-1', roots, modules: packageModules, edges: packageEdges, builtins: [...builtins].sort() };
const emitted = { schema: 'SD-ENROLLMENT-EMITTED-MAP-1', phases, edits };
function save(name, value) {
  const bytes = JSON.stringify(value); check(Buffer.byteLength(bytes) < 8 * 1024 * 1024, 'Map overflow');
  fs.writeFileSync(path.join(outputDirectory, name), bytes + '\n', { flag: 'wx', mode: 0o600 });
}
check(Object.keys(packageModules).length <= 512 && Object.keys(phases).length === 6, 'Map row bound');
save('runtime-modules.json', runtime); save('emitted-modules.json', emitted);
save('emission-report.json', { schema: 'SD-ENROLLMENT-EMISSION-1', status: 'EMIT_ONLY_NOT_TYPECHECKED_NOT_RUNTIME', compiler: ts.version,
  compilerSha256: sha(fs.readFileSync(require.resolve('typescript'))), libraryReads: reads, diagnostics, diagnosticPolicyProofs, nodeDiagnostic, edits,
  sourcePins: plan.sourcePins, packageFiles: Object.fromEntries(Object.entries(packageModules).map(([id, code]) => [id, sha(code)])), builtins: runtime.builtins });

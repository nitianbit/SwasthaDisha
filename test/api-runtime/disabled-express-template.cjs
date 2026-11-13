'use strict';
// One frozen, disabled capability shared by the two focused HTTP fixtures.
const Module = require('node:module');
const { types } = require('node:util');
const EXPRESS_VIEW_POLICY = Object.freeze({
  schema: 'SD-DISABLED-EXPRESS-VIEW-1',
  parent: 'node_modules/express/lib/view.js',
  parentSha256: 'ec627880c1b43aee5887164ac2e9c58f01e4ee8086e23a829eddf1af3858c021',
  entryParent: 'node_modules/express/lib/application.js',
  entryParentSha256: '5901b32f609ba349351bf7406dbdc0c4c57b77ce6f7215ea67ccca5ac2a28e88',
  entrySpecifier: './view', functionName: 'View', functionParameters: Object.freeze(['name', 'options']),
  guard: '!opts.engines[this.ext]', targetDeclaration: 'var mod = this.ext.slice(1)',
  expression: 'require(mod)', containingExpression: 'require(mod).__express', resultBinding: 'fn',
  initialLiteralRequests: Object.freeze(['debug', 'path', 'fs']), initialRequestCounts: Object.freeze([1, 1, 1]),
  moduleExport: 'module.exports = View', disabledCapability: 'template-engine-loading',
});
const EXPRESS_VIEW_POLICY_SHA256 = '8a9b9d03d5fda5c029c206089864d99d45313a3a7a850532f78eb9eda9d49dcd';

// The caller supplies its admitted TypeScript parser. This function never imports it.
function matchDisabledExpressViewSite(ts, tree, node, parentPath, parentSha256) {
  const p = EXPRESS_VIEW_POLICY, compact = text => text.replace(/\s+/g, '');
  if (parentPath !== p.parent || parentSha256 !== p.parentSha256 || !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) || node.expression.text !== 'require' || node.arguments.length !== 1 ||
      !ts.isIdentifier(node.arguments[0]) || node.arguments[0].text !== 'mod' || compact(node.getText(tree)) !== p.expression) return false;
  let fn, branch;
  for (let current = node.parent; current; current = current.parent) {
    if (!branch && ts.isIfStatement(current)) branch = current;
    if (ts.isFunctionLike(current)) { fn = current; break; }
  }
  if (!fn || !ts.isFunctionDeclaration(fn) || fn.parent !== tree || fn.name?.text !== p.functionName ||
      fn.parameters.length !== 2 || fn.parameters.some((param, i) => !ts.isIdentifier(param.name) || param.name.text !== p.functionParameters[i]) ||
      !branch || !ts.isBlock(branch.thenStatement) || compact(branch.expression.getText(tree)) !== p.guard ||
      !(branch.thenStatement.pos <= node.pos && node.end <= branch.thenStatement.end)) return false;
  const access = node.parent, declaration = access?.parent;
  if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== node || access.name.text !== '__express' ||
      !declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer !== access ||
      !ts.isIdentifier(declaration.name) || declaration.name.text !== p.resultBinding ||
      !ts.isVariableDeclarationList(declaration.parent) || declaration.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) return false;
  const statements = branch.thenStatement.statements;
  const target = statements.find(statement => ts.isVariableStatement(statement) &&
    !(statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) && statement.declarationList.declarations.length === 1 &&
    compact(statement.getText(tree)).replace(/;$/, '') === compact(p.targetDeclaration));
  if (!target || target.end > node.pos) return false;
  const computed = [];
  const walk = current => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'require' &&
        (current.arguments.length !== 1 || !ts.isStringLiteral(current.arguments[0]))) computed.push(current);
    ts.forEachChild(current, walk);
  };
  walk(tree);
  if (computed.length !== 1 || computed[0] !== node) return false;
  const initial = [], exports = [];
  let eagerViewCall = false;
  const eager = (current, statement) => {
    if (ts.isFunctionLike(current)) return;
    if ((ts.isCallExpression(current) || ts.isNewExpression(current)) && ts.isIdentifier(current.expression) && current.expression.text === p.functionName) eagerViewCall = true;
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'require' &&
        current.arguments.length === 1 && ts.isStringLiteral(current.arguments[0])) initial.push({ request: current.arguments[0].text, end: statement.end });
    ts.forEachChild(current, child => eager(child, statement));
  };
  for (const statement of tree.statements) {
    if (ts.isExpressionStatement(statement) && compact(statement.expression.getText(tree)) === compact(p.moduleExport)) exports.push(statement);
    eager(statement, statement);
  }
  if (initial.length !== 3 || initial.some((row, i) => row.request !== p.initialLiteralRequests[i]) ||
      exports.length !== 1 || initial.some(row => row.end > exports[0].pos)) return false;
  return !eagerViewCall;
}

function createExpressViewGuard(root, manifestFileHashes, deny) {
  let state = 'NEW', captured = null, finalExports = null, incoming = false, frame = null, count = 0;
  const reject = () => { deny(); throw new Error('TEMPLATE_ENGINE_DISABLED'); };
  const fatal = () => { state = 'FAILED'; return reject(); };
  const need = ok => { if (!ok) fatal(); };
  need(typeof deny === 'function' && typeof root === 'string' && root.startsWith('/') && !root.endsWith('/') &&
    root.split('/').slice(1).every(part => part && part !== '.' && part !== '..'));
  const targetPath = root + '/' + EXPRESS_VIEW_POLICY.parent;
  const entryPath = root + '/' + EXPRESS_VIEW_POLICY.entryParent;
  const own = (object, key) => {
    need(object !== null && (typeof object === 'object' || typeof object === 'function') && !types.isProxy(object));
    const d = Object.getOwnPropertyDescriptor(object, key);
    need(d !== undefined && Object.hasOwn(d, 'value'));
    return d.value;
  };
  need(!types.isProxy(Module));
  const nativePrototype = own(Module, 'prototype'), cache = own(Module, '_cache');
  need(cache !== null && typeof cache === 'object' && !types.isProxy(cache));
  need(own(manifestFileHashes, EXPRESS_VIEW_POLICY.parent) === EXPRESS_VIEW_POLICY.parentSha256 &&
    own(manifestFileHashes, EXPRESS_VIEW_POLICY.entryParent) === EXPRESS_VIEW_POLICY.entryParentSha256);
  const cacheEntry = filename => {
    const d = Object.getOwnPropertyDescriptor(cache, filename);
    if (d === undefined) return undefined;
    need(Object.hasOwn(d, 'value'));
    return d.value;
  };
  need(Object.getOwnPropertyDescriptor(cache, targetPath) === undefined);
  const moduleAt = (object, filename, loaded) => {
    need(object !== null && typeof object === 'object' && !types.isProxy(object) && Object.getPrototypeOf(object) === nativePrototype);
    need(own(object, 'filename') === filename && own(object, 'id') === filename &&
      own(object, 'loaded') === loaded && cacheEntry(filename) === object);
    return own(object, 'exports');
  };
  const integrity = () => {
    need(state !== 'FAILED' && own(Module, '_cache') === cache && own(Module, 'prototype') === nativePrototype && !types.isProxy(cache));
    if (captured !== null) {
      const exported = moduleAt(captured, targetPath, state === 'SEALED');
      if (state === 'SEALED') need(exported === finalExports);
    }
  };
  const parentKind = parent => {
    if (parent === null || parent === undefined) return 'other';
    need(typeof parent === 'object' && !types.isProxy(parent));
    const filename = own(parent, 'filename'), id = own(parent, 'id');
    if (parent === captured || filename === targetPath || id === targetPath) return 'view';
    if (filename === entryPath || id === entryPath) return 'entry';
    return 'other';
  };
  const checkEntry = parent => { moduleAt(parent, entryPath, false); };
  function load(request, parent, forward) {
    integrity();
    const kind = parentKind(parent);
    if (kind === 'view') {
      if (state === 'SEALED') {
        need(parent === captured); moduleAt(parent, targetPath, true);
        return reject(); // Deliberate intact capability denial cannot poison SEALED.
      }
      need(state === 'ENTERING' && incoming && frame === null && count < 3);
      moduleAt(parent, targetPath, false);
      if (captured === null) { need(count === 0); captured = parent; }
      need(parent === captured && request === EXPRESS_VIEW_POLICY.initialLiteralRequests[count]);
      count++; frame = { request, parent };
      try { return forward(); }
      catch (error) { state = 'FAILED'; throw error; }
      finally { frame = null; }
    }
    if (kind === 'entry' && request === EXPRESS_VIEW_POLICY.entrySpecifier) {
      need(state === 'NEW' && !incoming && frame === null && captured === null && Object.getOwnPropertyDescriptor(cache, targetPath) === undefined);
      checkEntry(parent); state = 'ENTERING'; incoming = true;
      let result;
      try {
        result = forward();
        need(state === 'ENTERING' && captured !== null && count === 3 && frame === null);
        finalExports = moduleAt(captured, targetPath, true);
        need(typeof finalExports === 'function' && !types.isProxy(finalExports) && result === finalExports);
        state = 'SEALED';
        return result;
      } catch (error) { state = 'FAILED'; throw error; }
      finally { incoming = false; frame = null; }
    }
    // Preserve unrelated optional exceptions and existing loader policy exactly.
    return forward();
  }
  function resolve(request, parent) {
    integrity();
    const kind = parentKind(parent);
    if (kind === 'view') {
      if (state === 'SEALED') { need(parent === captured); return reject(); }
      need(state === 'ENTERING' && incoming && parent === captured && frame !== null &&
        frame.parent === parent && frame.request === request);
    } else if (kind === 'entry' && request === EXPRESS_VIEW_POLICY.entrySpecifier) {
      need(state === 'ENTERING' && incoming && captured === null && frame === null);
      checkEntry(parent);
    }
  }
  function assertSealed() {
    integrity(); need(state === 'SEALED' && captured !== null && count === 3 && !incoming && frame === null);
    need(moduleAt(captured, targetPath, true) === finalExports);
    return finalExports;
  }
  return Object.freeze({ load, resolve, assertSealed });
}
module.exports = Object.freeze({ EXPRESS_VIEW_POLICY, EXPRESS_VIEW_POLICY_SHA256, matchDisabledExpressViewSite, createExpressViewGuard });

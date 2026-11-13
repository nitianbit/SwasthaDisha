/** Syntax-only emission into memory. Never evaluates application code or writes build output. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const compilerFile = process.argv[2];
const manifestFile = process.argv[3];
assert.equal(process.argv.length, 4, 'supply exactly the reviewed compiler and source manifest');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(readFileSync(compilerFile)), '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675');
const ts = createRequire(import.meta.url)(compilerFile);
assert.equal(ts.version, '5.9.3');
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
assert.equal(manifest.schema, 'CUSTOMER_MILESTONE_TS_SYNTAX_INPUTS_1');
assert.ok(manifest.files.length > 0 && manifest.files.length <= 32);
assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
const root = new URL('../../', import.meta.url);
const results = [];
for (const entry of manifest.files) {
  assert.match(entry.path, /^src1\/[A-Za-z0-9_/-]+\.ts$/);
  assert.ok(!entry.path.split('/').includes('..'));
  const bytes = readFileSync(new URL(entry.path, root));
  assert.equal(sha(bytes), entry.sha256, 'source binding ' + entry.path);
  const result = ts.transpileModule(bytes.toString('utf8'), {
    fileName: entry.path, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: true, isolatedModules: true },
  });
  const errors = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error)
    .map(item => ({ code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }));
  results.push({ path: entry.path, emittedBytes: Buffer.byteLength(result.outputText), errors });
}
const failed = results.some(item => item.errors.length);
console.log(JSON.stringify({ status: failed ? 'FAIL' : 'PASS', compilerVersion: ts.version,
  compilerSha256: '3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675', results,
  limits: ['Syntax-only TypeScript transpileModule with output held in memory',
    'No semantic typecheck, dependency resolution, root build/start or application/model/provider evaluation'] }, null, 2));
if (failed) process.exitCode = 1;

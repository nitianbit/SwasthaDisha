// Fixed one-run operator. Its presence grants no application/runtime authority.
import { readFileSync, lstatSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const HERE = fileURLToPath(new URL('.', import.meta.url));
const NODE_SHA = '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0';
const DECISION = 'APPROVE_ONE_FIXED_AUTH_API_RUN';
const APPROVAL = '/private/tmp/sd-auth-api-runtime-approval.json';
const sha = (data) => createHash('sha256').update(data).digest('hex');
const need = (ok, message) => { if (!ok) throw new Error(message); };
const exactKeys = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...keys].sort());
function regular(path) {
  const st = lstatSync(path);
  need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'Nonregular operator input');
  return readFileSync(path);
}
function git(args) {
  const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
    cwd: ROOT, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024,
  });
  need(!result.error && !result.signal && result.status === 0, 'Source readback unavailable');
  return result.stdout.trim();
}
function frozenSource(commit) {
  need(git(['rev-parse', 'HEAD']) === commit && git(['status', '--porcelain', '--untracked-files=all']) === '', 'Source freeze changed');
}

export function validateReceipt(receipt, expected) {
  need(exactKeys(receipt, [...Object.keys(expected), 'reviewers'])
    && Object.keys(expected).every((key) => receipt[key] === expected[key]), 'Approval does not bind the exact invocation');
  need(Array.isArray(receipt.reviewers) && receipt.reviewers.length === 2
    && receipt.reviewers.every((r) => exactKeys(r, ['agent', 'decision']) && r.decision === DECISION
      && typeof r.agent === 'string' && /^\/root\/[A-Za-z0-9_/]+$/.test(r.agent))
    && new Set(receipt.reviewers.map((r) => r.agent)).size === 2, 'Two actual independent invocation decisions required');
}

/** Persist a request before entry; never infer entry from that bookkeeping. */
export async function requestRun(run, report, save) {
  report.runRequested = true; report.status = 'RUN_REQUESTED'; save();
  const pending = run();
  report.runEntered = true;
  // No fallible report write between starting and awaiting the owned run.
  return await pending;
}

async function main() {
  need(process.argv.length === 2 && process.execArgv.length === 0
    && Object.keys(process.env).every((key) => ['PATH', 'TMPDIR'].includes(key))
    && process.env.TMPDIR === '/private/tmp' && process.version === 'v22.23.4'
    && process.execPath === '/private/tmp/m0-node22/node' && sha(regular(process.execPath)) === NODE_SHA,
  'Use the exact clean-env pinned operator invocation');
  const approvalStat = lstatSync(APPROVAL);
  need(approvalStat.uid === process.getuid() && (approvalStat.mode & 0o022) === 0, 'Unsafe invocation receipt');
  const approvalBytes = regular(APPROVAL); const receipt = JSON.parse(approvalBytes);
  const templateBytes = regular(join(HERE, 'scenario/runtime-template.json'));
  const template = JSON.parse(templateBytes);
  const sourceCommit = git(['rev-parse', 'HEAD']);
  need(/^[a-f0-9]{40}$/.test(sourceCommit) && template.sourceCommit === sourceCommit, 'Template source identity differs');
  const expected = { schema: 'SD-AUTH-API-INVOCATION-APPROVAL-1', decision: DECISION,
    sourceRoot: ROOT, sourceCommit, operatorSha: sha(regular(fileURLToPath(import.meta.url))),
    platformSha: sha(regular(join(HERE, 'platform.mjs'))), profileSha: sha(regular(join(HERE, 'profile.json'))),
    networkSha: sha(regular(join(HERE, '../application/app-bundle.mjs'))),
    templateSha: sha(templateBytes), lockSha: template.lockSha, portsSha: template.portsSha,
    hostNodeSha: NODE_SHA };
  validateReceipt(receipt, expected); frozenSource(sourceCommit);
  const claim = '/private/tmp/sd-auth-api-once-' + sourceCommit + '-' + expected.templateSha + '.claim.json';
  const reportDirectory = mkdtempSync('/private/tmp/sd-auth-api-invocation-');
  const directoryIdentity = lstatSync(reportDirectory);
  const report = { schema: 'SD-AUTH-API-INVOCATION-1', sourceCommit, operatorSha: expected.operatorSha,
    approvalSha: sha(approvalBytes), templateSha: expected.templateSha, status: 'CLAIMED_NOT_ENTERED',
    fixtureHandleReturned: false, runRequested: false, runEntered: false, cleanup: 'NOT_NEEDED', created: [] };
  const save = () => {
    const now = lstatSync(reportDirectory);
    need(now.isDirectory() && !now.isSymbolicLink() && now.dev === directoryIdentity.dev && now.ino === directoryIdentity.ino,
      'Operator report directory identity changed');
    writeFileSync(join(reportDirectory, 'operator-result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  };
  // Exclusive claim precedes constructor/run. An interrupted/failed claim is never reused.
  writeFileSync(claim, JSON.stringify({ sourceCommit, templateSha: expected.templateSha, approvalSha: report.approvalSha,
    reportDirectory }) + '\n', { flag: 'wx', mode: 0o600 }); save();
  writeFileSync(join(reportDirectory, 'one-run-approval.json'), approvalBytes, { flag: 'wx', mode: 0o600 });
  let fixture;
  try {
    const { PROFILE, createApiRuntimeFixture } = await import('./platform.mjs');
    frozenSource(sourceCommit);
    need(sha(regular(join(HERE, 'scenario/runtime-template.json'))) === expected.templateSha, 'Prepared descriptor changed');
    fixture = createApiRuntimeFixture({ endpoint: PROFILE.endpoint }); report.fixtureHandleReturned = true;
    report.runId = fixture.runId; report.workspace = fixture.directory; save();
    const result = await requestRun(() => fixture.run(), report, save);
    frozenSource(sourceCommit);
    need(sha(regular(join(HERE, 'scenario/runtime-template.json'))) === expected.templateSha, 'Prepared descriptor changed after run');
    report.result = result; report.status = 'API_RESULT_PENDING_CLEANUP'; save();
  } catch {
    report.status = 'FAILED_REVIEW_REQUIRED'; process.exitCode = 1;
  } finally {
    if (fixture) {
      report.created = fixture.describe().resources;
      try { report.cleanupReceipt = fixture.dispose(); report.cleanup = 'VERIFIED'; }
      catch { report.cleanup = 'UNRESOLVED'; report.status = 'UNRESOLVED'; process.exitCode = 1; }
    }
    if (report.status === 'API_RESULT_PENDING_CLEANUP' && report.cleanup === 'VERIFIED') report.status = 'FOCUSED_API_PASS';
    save();
    process.stdout.write(JSON.stringify({ status: report.status, reportDirectory, runEntered: report.runEntered,
      createdResources: report.created.length, cleanup: report.cleanup }) + '\n');
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => {
  process.stderr.write('Fixed API invocation rejected before a reviewable result; inspect the owned claim/report if present.\n');
  process.exitCode = 1;
});

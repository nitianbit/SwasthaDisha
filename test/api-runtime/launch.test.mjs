import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReceipt, requestRun, validateOperatorEnvironment } from './launch.mjs';
const decision = 'APPROVE_ONE_FIXED_AUTH_API_RUN';
const expected = { schema: 'SD-AUTH-API-INVOCATION-APPROVAL-1', decision, sourceCommit: 'a'.repeat(40), templateSha: 'b'.repeat(64) };
const receipt = () => ({ ...expected, reviewers: [{ agent: '/root/standards', decision }, { agent: '/root/spec', decision }] });
test('exact two-review invocation receipt is accepted by the pure validator', () => assert.doesNotThrow(() => validateReceipt(receipt(), expected)));
for (const key of Object.keys(expected)) test('changed invocation binding is rejected: ' + key, () => {
  const value = receipt(); value[key] = 'unreviewed'; assert.throws(() => validateReceipt(value, expected), /exact invocation/);
});
for (const [label, mutate] of [
  ['unknown-field', r => { r.uri = 'unreviewed'; }],
  ['missing-field', r => { delete r.templateSha; }],
  ['one-reviewer', r => { r.reviewers.pop(); }],
  ['duplicate-reviewer', r => { r.reviewers[1] = r.reviewers[0]; }],
  ['author-self-review', r => { r.reviewers[0].agent = '/root'; }],
  ['wrong-decision', r => { r.reviewers[0].decision = 'APPROVE_SOURCE_ONLY'; }],
  ['unproved-review-payload', r => { r.reviewers[0].token = 'synthetic-secret'; }],
]) test('unsafe invocation receipt is rejected: ' + label, () => {
  const value = receipt(); mutate(value); assert.throws(() => validateReceipt(value, expected));
});

test('pre-run report failure cannot record actual method entry', async () => {
  const report = { runRequested: false, runEntered: false }; let calls = 0;
  await assert.rejects(requestRun(async () => { calls++; }, report, () => { throw Error('synthetic report failure'); }), /report failure/);
  assert.equal(calls, 0); assert.equal(report.runEntered, false); assert.equal(report.runRequested, true);
});
test('a called method that rejects still confirms entry after the request record', async () => {
  const report = { runRequested: false, runEntered: false }; const writes = [];
  await assert.rejects(requestRun(async () => { throw Error('synthetic owned run failure'); }, report, () => writes.push({ ...report })), /owned run failure/);
  assert.equal(writes.length, 1); assert.equal(writes[0].status, 'RUN_REQUESTED');
  assert.equal(writes[0].runEntered, false); assert.equal(report.runEntered, true);
});
test('an entered pending run is awaited without an intervening report write', async () => {
  let release; let called = false; const writes = [];
  const report = { runRequested: false, runEntered: false };
  const pending = requestRun(() => { called = true; return new Promise(resolve => { release = resolve; }); }, report, () => writes.push({ ...report }));
  assert.equal(called, true); assert.equal(report.runEntered, true); assert.equal(writes.length, 1);
  release('safe synthetic result'); assert.equal(await pending, 'safe synthetic result');
});
test('operator admits exact clean environment without OS locale metadata', () => {
  assert.doesNotThrow(() => validateOperatorEnvironment({ PATH: '/usr/bin:/bin', TMPDIR: '/private/tmp' }));
});
test('operator admits only the observed additional macOS locale key', () => {
  assert.doesNotThrow(() => validateOperatorEnvironment({ PATH: '/usr/bin:/bin', TMPDIR: '/private/tmp', __CF_USER_TEXT_ENCODING: 'synthetic-platform-metadata' }));
});
for (const key of ['NODE_OPTIONS', 'JWT_SECRET_KEY', 'UNREVIEWED_LOCALE']) test('operator still rejects ambient field: ' + key, () => {
  assert.throws(() => validateOperatorEnvironment({ PATH: '/usr/bin:/bin', TMPDIR: '/private/tmp', [key]: 'synthetic' }), /Unreviewed/);
});
test('operator refuses an alternate temporary root', () => {
  assert.throws(() => validateOperatorEnvironment({ PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }), /Unreviewed/);
});

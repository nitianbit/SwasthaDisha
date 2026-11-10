import assert from 'node:assert/strict';
import { PORT_OPERATIONS } from './app-bundle.mjs';
import { buildContainsRegex } from './queryUtils.ts';

export function runScenario(ports) {
  const filter = buildContainsRegex('a+b.*');
  assert.equal(filter.$regex, 'a\\+b\\.\\*');
  assert.equal(filter.$options, 'i');
  const matcher = new RegExp(filter.$regex, filter.$options);
  assert.equal(matcher.test('A+B.*'), true);
  assert.equal(matcher.test('aaabzz'), false);
  for (const [port, operation] of Object.entries(PORT_OPERATIONS)) {
    assert.equal(ports.request(port, operation, { syntheticId: 'fixture-only' }).effect, false);
  }
  assert.throws(() => ports.request('payments', 'settle-real-funds', { syntheticId: 'fixture-only' }), /Unconfigured/);
  return Object.freeze({ literalSearchPassed: true, unknownOperationRejected: true });
}

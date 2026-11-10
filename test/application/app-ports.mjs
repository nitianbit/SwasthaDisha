import { PORT_OPERATIONS, requireThat } from './app-bundle.mjs';

/** Recording fixtures never return payment success or perform external effects. */
export function createRecordingPorts() {
  const calls = [];
  return Object.freeze({
    request(port, operation, payload) {
      requireThat(Object.hasOwn(PORT_OPERATIONS, port) && PORT_OPERATIONS[port] === operation,
        'Unconfigured provider operation');
      requireThat(payload && Object.keys(payload).join(',') === 'syntheticId'
        && payload.syntheticId === 'fixture-only', 'Only the fixed synthetic payload is admitted');
      const receipt = Object.freeze({ port, operation, status: 'recorded', effect: false });
      calls.push(receipt);
      return receipt;
    },
    snapshot() { return Object.freeze(calls.map((call) => Object.freeze({ ...call }))); },
  });
}

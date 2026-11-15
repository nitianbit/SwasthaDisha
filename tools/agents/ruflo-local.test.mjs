import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ALLOWED_TOOLS, createPolicy, frames, watchPipeFailures } from './ruflo-local.mjs';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const response = (id, result) => ({ jsonrpc: '2.0', id, result });

test('all 13 coordination tools forward with their exact identifier and arguments', () => {
  assert.equal(ALLOWED_TOOLS.length, 13);
  assert.equal(new Set(ALLOWED_TOOLS).size, 13);
  for (const [index, name] of ALLOWED_TOOLS.entries()) {
    const frame = request('call-' + index, 'tools/call', { name, arguments: {} });
    const policy = createPolicy();
    assert.equal(policy.client(frame).forward, frame);
    const result = response(frame.id, { content: [{ type: 'text', text: 'synthetic' }] });
    assert.equal(policy.server(result).forward, result);
  }
});

test('unlisted execution, model and policy tools never forward, even without tools/list', () => {
  const policy = createPolicy();
  for (const name of ['agent_execute', 'memory_store', 'memory_search', 'terminal_execute', 'policy_update', '', '__proto__']) {
    const result = policy.client(request(name, 'tools/call', { name, arguments: {} }));
    assert.equal(result.forward, undefined);
    assert.equal(result.reply.error.code, -32602);
    assert.equal(result.reply.id, name);
  }
});

test('tools/list exposes only the approved tools and closes unused pagination', () => {
  const policy = createPolicy();
  policy.client(request(1, 'tools/list'));
  const filtered = policy.server(response(1, {
    tools: [...ALLOWED_TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })),
      { name: 'agent_execute' }, { name: 'memory_store' }, null], nextCursor: 'unapproved-page',
  })).forward;
  assert.deepEqual(filtered.result.tools.map((item) => item.name), ALLOWED_TOOLS);
  assert.equal(filtered.result.nextCursor, undefined);
});

test('only shallow health calls forward', () => {
  for (const arguments_ of [{}, { deep: false, fix: false }]) {
    assert.ok(createPolicy().client(request(1, 'tools/call', { name: 'system_health', arguments: arguments_ })).forward);
  }
  for (const arguments_ of [{ deep: true }, { fix: true }, { deep: 'false' }, { fix: null }]) {
    const result = createPolicy().client(request(1, 'tools/call', { name: 'system_health', arguments: arguments_ }));
    assert.equal(result.forward, undefined);
    assert.equal(result.reply.error.code, -32602);
  }
});

test('unknown methods, malformed requests and notification tool calls cannot forward', () => {
  const policy = createPolicy();
  for (const frame of [null, [], request(null, 'ping'), request({}, 'ping'), { ...request(1, 'ping'), jsonrpc: '1.0' },
    request(1, 'tools/call', { name: 'task_list', arguments: [] }), request(1, 'resources/read'), request(1, 'prompts/get')]) {
    const result = policy.client(frame);
    assert.equal(result.forward, undefined);
    assert.ok(result.reply.error);
  }
  assert.deepEqual(policy.client({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'task_create' } }), {});
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  assert.equal(policy.client(initialized).forward, initialized);
});

test('pending identifiers cannot collide and become reusable only after response', () => {
  const policy = createPolicy();
  const ping = request(1, 'ping');
  assert.equal(policy.client(ping).forward, ping);
  assert.equal(policy.client(ping).forward, undefined);
  assert.ok(policy.server(response(1, {})).forward);
  assert.equal(policy.client(ping).forward, ping);
  assert.throws(() => policy.server(response('unrequested', {})), /unknown request/);
});

test('outstanding request slots are bounded and errors release their slot', () => {
  const policy = createPolicy();
  for (let id = 0; id < 64; id++) assert.ok(policy.client(request(id, 'ping')).forward);
  assert.equal(policy.client(request(64, 'ping')).forward, undefined);
  policy.server({ jsonrpc: '2.0', id: 0, error: { code: -1, message: 'synthetic' } });
  assert.ok(policy.client(request(64, 'ping')).forward);
});

test('initialize advertises only proxied tools and server callbacks are rejected locally', () => {
  const policy = createPolicy();
  policy.client(request(1, 'initialize'));
  assert.deepEqual(policy.server(response(1, { capabilities: { tools: {}, resources: {}, prompts: {} } })).forward.result.capabilities,
    { tools: { listChanged: true } });
  const callback = policy.server(request('server-call', 'elicitation/create'));
  assert.equal(callback.forward, undefined);
  assert.equal(callback.reply.error.code, -32601);
  assert.equal(callback.reply.id, 'server-call');
});

test('framing tolerates split messages and blank lines without losing identifiers', async () => {
  const output = [];
  for await (const value of frames(Readable.from(['\n{"jsonrpc":"2.0",', '"id":9}\n\n{"id":"a"}\n']))) output.push(value);
  assert.deepEqual(output, [{ jsonrpc: '2.0', id: 9 }, { id: 'a' }]);
});

test('oversized, malformed and incomplete frames reject before forwarding', async () => {
  const collect = async (parts, limit) => { for await (const value of frames(Readable.from(parts), limit)) assert.fail(value); };
  await assert.rejects(collect(['{"x":"' + 'a'.repeat(100) + '"}\n'], 30), /size limit/);
  await assert.rejects(collect(['a'.repeat(31)], 30), /size limit/);
  await assert.rejects(collect(['{bad}\n'], 30), SyntaxError);
  await assert.rejects(collect(['{"id":1}'], 30), /Incomplete/);
});

test('asynchronous stdout, stderr and child-input failures enter cleanup once and preserve the first error', () => {
  for (let first = 0; first < 3; first++) {
    const streams = Array.from({ length: 3 }, () => new EventEmitter());
    const original = Object.assign(new Error('synthetic closed consumer'), { code: 'EPIPE' });
    let stops = 0;
    let unblocks = 0;
    let saved;
    const unwatch = watchPipeFailures(streams, (failure) => { saved = failure; stops++; unblocks++; });
    streams[first].emit('error', original);
    streams[(first + 1) % 3].emit('error', new Error('later pipe failure'));
    assert.equal(saved, original);
    assert.equal(stops, 1);
    assert.equal(unblocks, 1);
    unwatch();
    assert.ok(streams.every((stream) => stream.listenerCount('error') === 0));
  }
});

test('pipe watcher removal preserves listeners owned by the caller', () => {
  const stream = new EventEmitter();
  let previousCalls = 0;
  const previous = () => { previousCalls++; };
  stream.on('error', previous);
  const unwatch = watchPipeFailures([stream], () => assert.fail('released watcher must not run'));
  unwatch();
  stream.emit('error', new Error('synthetic after release'));
  assert.equal(previousCalls, 1);
  assert.deepEqual(stream.listeners('error'), [previous]);
});

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const absent = (pid) => {
  try { process.kill(pid, 0); return false; }
  catch (failure) { if (failure.code === 'ESRCH') return true; throw failure; }
};
async function until(check, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await pause(20); }
  assert.fail('Synthetic pipe fixture exceeded its bounded wait');
}
async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Adapter did not terminate after the broken output pipe')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

for (const sink of ['stdout', 'stderr']) {
  test('real adapter closes its exact synthetic child after client ' + sink + ' breaks', { timeout: 16000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'sd-ruflo-pipe-'));
    const identity = await lstat(home);
    const runtime = join(home, '.codex/runtimes/ruflo/3.75.0/node_modules/@claude-flow/cli');
    const marker = join(home, 'synthetic-child.json');
    let child;
    let closed;
    let fakePid;
    try {
      await mkdir(join(runtime, 'bin'), { recursive: true });
      await writeFile(join(runtime, 'package.json'), JSON.stringify({ type: 'module', version: '3.75.0' }));
      await writeFile(join(runtime, 'bin/cli.js'), `
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
writeFileSync(join(homedir(), 'synthetic-child.json'), JSON.stringify({ pid: process.pid, parent: process.ppid }));
// Remain alive if an unhandled adapter error closes either output consumer.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2025-11-25', serverInfo: { name: 'synthetic-fixture', version: '1' }, capabilities: {} } }) + '\\n');
  }
});
// Deliberately stay alive on stdin EOF so an adapter crash cannot masquerade as cleanup.
process.stdin.on('end', () => {});
setInterval(() => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress',
    params: { progressToken: 'synthetic', progress: 1 } }) + '\\n');
  process.stderr.write('synthetic child heartbeat\\n');
}, 20);
// A regression cannot leave an unbounded orphan; this is longer than the adapter's TERM deadline.
setTimeout(() => process.exit(0), 8000);
`);
      child = spawn(process.execPath, [fileURLToPath(new URL('./ruflo-local.mjs', import.meta.url))], {
        cwd: home, env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      closed = once(child, 'close');
      let output = '';
      child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-8192); });
      child.stderr.on('data', () => {});
      child.stdin.write(JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '1' } })) + '\n');
      await until(async () => {
        try {
          const ack = JSON.parse(await readFile(marker, 'utf8'));
          assert.equal(ack.parent, child.pid);
          assert.ok(Number.isSafeInteger(ack.pid) && ack.pid > 0);
          fakePid = ack.pid;
          return output.split('\n').some((line) => {
            try { const frame = JSON.parse(line); return frame.id === 1 && frame.result?.serverInfo?.name === 'synthetic-fixture'; }
            catch { return false; }
          });
        } catch (failure) { if (failure.code === 'ENOENT') return false; throw failure; }
      }, 2000);
      // Keep adapter stdin open. Only the consumer's read side disappears.
      child[sink].destroy();
      const [code, signal] = await bounded(closed, 7000);
      assert.equal(signal, null);
      assert.notEqual(code, 0);
      assert.ok(absent(fakePid), 'Exact synthetic child must be gone when the adapter finishes');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      if (child) { child.stdin.destroy(); await closed; }
      if (fakePid) await until(() => absent(fakePid), 10000);
      const current = await lstat(home);
      assert.equal(current.dev, identity.dev);
      assert.equal(current.ino, identity.ino);
      await rm(home, { recursive: true });
    }
  });
}

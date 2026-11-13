import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_TOOLS = Object.freeze([
  'mcp_status', 'system_health', 'team_create', 'team_spawn', 'team_send',
  'team_inbox', 'team_status', 'team_shutdown', 'task_create', 'task_status',
  'task_list', 'task_update', 'task_complete',
]);
const allowed = new Set(ALLOWED_TOOLS);
const methods = new Set(['initialize', 'ping', 'tools/list', 'tools/call']);
const notifications = new Set(['notifications/initialized', 'notifications/cancelled']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' || Number.isSafeInteger(value);
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Pure routing policy. Only accepted requests acquire an upstream response slot. */
export function createPolicy() {
  const pending = new Map();
  return {
    client(message) {
      const id = object(message) && identifier(message.id) ? message.id : null;
      const reject = (code, text) => ({ reply: error(id, code, text) });
      if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
        || (message.params !== undefined && !object(message.params))) {
        return reject(-32600, 'Invalid MCP request');
      }
      if (!Object.hasOwn(message, 'id')) {
        return notifications.has(message.method) ? { forward: message } : {};
      }
      if (!identifier(message.id)) return reject(-32600, 'Invalid request identifier');
      if (!methods.has(message.method)) return reject(-32601, 'Method is outside the local coordination profile');
      if (pending.has(id)) return reject(-32600, 'Request identifier is already pending');
      if (pending.size >= 64) return reject(-32000, 'Too many pending coordination requests');
      if (message.method === 'tools/call') {
        const params = message.params;
        if (!object(params) || !allowed.has(params.name)
          || (params.arguments !== undefined && !object(params.arguments))) {
          return reject(-32602, 'Tool is outside the local coordination profile');
        }
        if (params.name === 'system_health'
          && [params.arguments?.deep, params.arguments?.fix].some((value) => value !== undefined && value !== false)) {
          return reject(-32602, 'Only shallow, non-repairing health checks are supported');
        }
      }
      pending.set(id, message.method);
      return { forward: message };
    },
    server(message) {
      if (!object(message) || message.jsonrpc !== '2.0') throw new Error('Invalid upstream MCP frame');
      if (Object.hasOwn(message, 'method')) {
        if (Object.hasOwn(message, 'id')) return { reply: error(message.id, -32601, 'Client callbacks are not supported') };
        return ['notifications/tools/list_changed', 'notifications/progress', 'notifications/message'].includes(message.method)
          ? { forward: message } : {};
      }
      if (!pending.has(message.id)) throw new Error('Upstream returned an unknown request identifier');
      const method = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) return { forward: message };
      if (!object(message.result)) throw new Error('Invalid upstream MCP result');
      if (method === 'initialize') {
        return { forward: { ...message, result: { ...message.result, capabilities: { tools: { listChanged: true } } } } };
      }
      if (method === 'tools/list') {
        if (!Array.isArray(message.result.tools)) throw new Error('Invalid upstream tool inventory');
        return { forward: { ...message, result: { tools: message.result.tools.filter((tool) => object(tool) && allowed.has(tool.name)) } } };
      }
      return { forward: message };
    },
  };
}

/** Bound each newline-delimited JSON frame before parsing or forwarding it. */
export async function* frames(stream, limit = 2 * 1024 * 1024) {
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > limit) throw new Error('MCP frame exceeds the local size limit');
      if (line.trim()) yield JSON.parse(line);
    }
    if (Buffer.byteLength(buffer) > limit) throw new Error('MCP frame exceeds the local size limit');
  }
  if (buffer.trim()) throw new Error('Incomplete MCP frame at end of stream');
}

async function write(stream, message) {
  if (stream.destroyed || stream.writableEnded || !stream.writable) throw new Error('MCP transport pipe is closed');
  if (!stream.write(JSON.stringify(message) + '\n')) await once(stream, 'drain');
}

/** Keep asynchronous pipe errors inside the owned-child cleanup path. */
export function watchPipeFailures(streams, onFailure) {
  let failed = false;
  const listener = (failure) => {
    if (!failed) { failed = true; onFailure(failure); }
  };
  for (const stream of streams) stream.on('error', listener);
  return () => { for (const stream of streams) stream.removeListener('error', listener); };
}

/** One fixed local runtime, one state directory; no caller-provided commands. */
async function main() {
  if (process.argv.length !== 2) throw new Error('This adapter accepts no command-line arguments');
  const home = homedir();
  const runtime = join(home, '.codex/runtimes/ruflo/3.75.0/node_modules/@claude-flow/cli');
  const state = join(home, '.codex/ruflo-state/swasthadisha');
  if (JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version !== '3.75.0') {
    throw new Error('The pinned Ruflo CLI 3.75.0 is required');
  }
  mkdirSync(join(state, 'config/ruflo/policy-trust'), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [join(runtime, 'bin/cli.js'), 'mcp', 'start', '--transport', 'stdio'], {
    cwd: state, stdio: ['pipe', 'pipe', 'pipe'], env: {
      HOME: home, PATH: dirname(process.execPath) + ':/usr/bin:/bin',
      CLAUDE_FLOW_CWD: state, CLAUDE_FLOW_MEMORY_PATH: join(state, '.swarm'),
      CLAUDE_FLOW_DISABLE_BRIDGE: '1', RUFLO_DAEMON_AUTOSTART: '0',
      XDG_CONFIG_HOME: join(state, 'config'), TRANSFORMERS_CACHE: join(state, 'model-cache'),
      HF_HOME: join(state, 'model-cache'), CLAUDE_FLOW_MCP_TOOLS: ALLOWED_TOOLS.join(','),
    },
  });
  const policy = createPolicy();
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    const remaining = Math.max(0, 64 * 1024 - stderrBytes);
    if (remaining) process.stderr.write(chunk.subarray(0, remaining));
    stderrBytes += chunk.length;
  });
  let stopTimer;
  let killTimer;
  let transportFailure;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    stopTimer ??= setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, 5000);
  };
  const unwatch = watchPipeFailures([process.stdout, process.stderr, child.stdin], (failure) => {
    transportFailure ??= failure;
    stop();
    process.stdin.destroy();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => {
      clearTimeout(stopTimer);
      clearTimeout(killTimer);
      process.stdin.destroy();
      resolveExit({ code, signal });
    });
  });
  const upstream = (async () => {
    for await (const frame of frames(child.stdout)) {
      const routed = policy.server(frame);
      if (routed.forward) await write(process.stdout, routed.forward);
      if (routed.reply) await write(child.stdin, routed.reply);
    }
  })();
  const downstream = (async () => {
    try {
      for await (const frame of frames(process.stdin)) {
        const routed = policy.client(frame);
        if (routed.reply) await write(process.stdout, routed.reply);
        if (routed.forward) await write(child.stdin, routed.forward);
      }
    } finally { stop(); }
  })();
  try {
    const [, , result] = await Promise.all([upstream, downstream, exited]);
    if (transportFailure) throw transportFailure;
    if (result.code !== 0 || result.signal) throw new Error('Local Ruflo server exited abnormally');
  } catch (failure) {
    stop();
    child.kill('SIGTERM');
    await Promise.allSettled([upstream, downstream, exited]);
    throw transportFailure ?? failure;
  } finally {
    clearTimeout(stopTimer);
    clearTimeout(killTimer);
    unwatch();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((failure) => {
    process.exitCode = 1;
    if (!process.stderr.destroyed) {
      // A final diagnostic can itself encounter a closed consumer after cleanup.
      const ignoreClosedSink = () => {};
      process.stderr.once('error', ignoreClosedSink);
      process.stderr.write('Local Ruflo adapter: ' + failure.message + '\n', (writeFailure) => {
        if (!writeFailure) process.stderr.removeListener('error', ignoreClosedSink);
      });
    }
  });
}

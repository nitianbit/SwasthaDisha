"""Fixed local Ruflo transport check. Never invokes a model or edits MCP profiles.

Import is inert. Tests must supply every fake port explicitly; main alone wires
the reviewed real process port after fixed-input admission.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import stat
import subprocess
import sys
import threading
import time
import tomllib
import uuid

HOME = Path('/Users/shubham')
ROOT = HOME / 'Desktop/SwasthaDisha/SwasthaDisha'
STATE = HOME / '.codex/ruflo-state/swasthadisha'
RUNTIME = HOME / '.codex/runtimes/ruflo/3.75.0'
CLI = RUNTIME / 'node_modules/@claude-flow/cli'
NODE = HOME / '.nvm/versions/node/v24.19.0/bin/node'
ADAPTER_SHA = '57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d'
INSTALLED = STATE / 'adapters' / ADAPTER_SHA / 'ruflo-local.mjs'
TOOLS = frozenset(('mcp_status', 'system_health', 'team_create', 'team_spawn',
                  'team_send', 'team_inbox', 'team_status', 'team_shutdown',
                  'task_create', 'task_status', 'task_list', 'task_update', 'task_complete'))
ENV = {'CLAUDE_FLOW_CWD': str(STATE), 'CLAUDE_FLOW_MEMORY_PATH': str(STATE / '.swarm'),
       'CLAUDE_FLOW_DISABLE_BRIDGE': '1', 'RUFLO_DAEMON_AUTOSTART': '0',
       'XDG_CONFIG_HOME': str(STATE / 'config'),
       'TRANSFORMERS_CACHE': str(STATE / 'model-cache'), 'HF_HOME': str(STATE / 'model-cache')}
PINS = {ROOT / 'tools/agents/ruflo-local.mjs': ADAPTER_SHA,
        ROOT / 'tools/agents/ruflo-local.test.mjs': 'ca37e313b992af1acce851e8f2b4f1bc13443715396d5c098c0b7a33047cfc3b',
        INSTALLED: ADAPTER_SHA,
        NODE: '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1',
        RUNTIME / 'package-lock.json': '8ac77ad0a7a64b698abe9566f12fc2d7bd583741bcf9167e5cc5cb6c7d19f646',
        CLI / 'package.json': 'a898ebf657810d9894d6505db55c11a94ca8b1766c08468552d41e4378beeaf0',
        CLI / 'bin/cli.js': '5b65e02510e0d94174a557ce77c5a62c5e19093ec4d1d9b39ddfdfa93932a1f7'}
LIVE_TEAM = 'swasthadisha-local'
FRAME_LIMIT = 2 * 1024 * 1024


class SmokeError(Exception):
    """Only fixed diagnostic codes enter reports; upstream text never does."""


def need(condition, code):
    if not condition:
        raise SmokeError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    need(stat.S_ISREG(path.lstat().st_mode), 'INPUT_NOT_REGULAR')
    return path.read_bytes()


def directory(path):
    need(stat.S_ISDIR(path.lstat().st_mode), 'STATE_NOT_REAL_DIRECTORY')


def identity(path):
    s = path.lstat()
    return (s.st_dev, s.st_ino)


def absent(path):
    need(not os.path.lexists(path), 'EXISTING_OR_PARTIAL_STATE')


def team_path(state, name):
    return state / '.claude-flow/teams' / name


def no_live_state(state):
    directory(state)
    for path in (state / '.claude-flow', state / '.claude-flow/teams'):
        if os.path.lexists(path):
            directory(path)
    absent(state / 'extension-link.json')
    absent(team_path(state, LIVE_TEAM))


def admit(*, pins, node, adapter, state, environment, codex, claude, package):
    """Pure/file-data admission; no allocation, process or transport fallback."""
    for path, expected in pins.items():
        need(digest(regular(path)) == expected, 'INPUT_HASH_MISMATCH')
    need(package.get('version') == '3.75.0', 'WRONG_RUFLO_VERSION')
    need(set(codex) <= {'command', 'args', 'cwd', 'env', 'enabled_tools',
                       'startup_timeout_sec', 'tool_timeout_sec'}, 'UNREVIEWED_CODEX_PROFILE_FIELD')
    for field in ('startup_timeout_sec', 'tool_timeout_sec'):
        if field in codex:
            need(type(codex[field]) in (int, float) and 0 < codex[field] <= 3600, 'INVALID_CODEX_TIMEOUT')
    need(codex.get('command') == str(node) and codex.get('args') == [str(adapter)], 'CODEX_COMMAND_MISMATCH')
    need(codex.get('cwd') == str(state) and codex.get('env') == environment, 'CODEX_ENV_MISMATCH')
    enabled = codex.get('enabled_tools')
    need(isinstance(enabled, list) and len(enabled) == 13 and set(enabled) == TOOLS, 'CODEX_TOOLS_MISMATCH')
    need(claude.get('type') == 'stdio' and claude.get('command') == str(node)
         and claude.get('args') == [str(adapter)] and claude.get('env', {}) == {}
         and set(claude) <= {'type', 'command', 'args', 'env'}, 'CLAUDE_PROFILE_MISMATCH')
    no_live_state(state)
    return {'node': node, 'adapter': adapter, 'state': state,
            'env': {'HOME': str(HOME), 'PATH': str(node.parent) + ':/usr/bin:/bin', **environment},
            'input_hashes': {str(p): h for p, h in pins.items()},
            'profile_sha256': digest(json.dumps({'codex': {k: codex[k] for k in
                ('command', 'args', 'cwd', 'env', 'enabled_tools')}, 'claude': claude}, sort_keys=True).encode())}


class HeldFile:
    """An exclusive file reservation; replacement never grants write authority."""
    def __init__(self, path):
        self.path = path
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        s = os.fstat(self.fd)
        self.key = (s.st_dev, s.st_ino)

    def write(self, value):
        need(identity(self.path) == self.key, 'RESERVATION_REPLACED')
        data = (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
        os.lseek(self.fd, 0, os.SEEK_SET)
        os.ftruncate(self.fd, 0)
        with os.fdopen(os.dup(self.fd), 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        need(identity(self.path) == self.key, 'RESERVATION_REPLACED')

    def release(self):
        need(identity(self.path) == self.key, 'RESERVATION_REPLACED')
        self.path.unlink()

    def close(self):
        os.close(self.fd)


def process_identity(pid):
    """Metadata only: no process arguments, environment or credential access."""
    need(type(pid) is int and pid > 1, 'INVALID_PROCESS_PID')
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,pgid=,lstart='],
                            env={'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, timeout=3)
    need(not result.stderr.strip(), 'PROCESS_IDENTITY_UNKNOWN')
    if result.returncode == 1 and not result.stdout.strip():
        return None
    need(result.returncode == 0, 'PROCESS_IDENTITY_UNKNOWN')
    fields = result.stdout.strip().split(None, 3)
    need(len(fields) == 4 and fields[0] == str(pid), 'PROCESS_IDENTITY_UNKNOWN')
    return (int(fields[0]), int(fields[1]), int(fields[2]), fields[3])


def cleanup_process(child, adapter_identity, ruflo_identity, *, inspect, send_signal):
    """All process ports mandatory. Only exact acknowledged identities qualify."""
    result = {'forced': False, 'adapter_absent': False, 'ruflo_absent': False,
              'exit_code': None, 'safe': False}
    try:
        try:
            if child.stdin and not child.stdin.closed:
                child.stdin.close()
        except (OSError, ValueError):
            result['error'] = 'OWNED_STDIN_CLOSE_FAILED'
        try:
            child.wait(timeout=9)  # longer than adapter's 5s TERM + 2s KILL
        except subprocess.TimeoutExpired:
            result['forced'] = True
            need(adapter_identity is not None and inspect(child.pid) == adapter_identity, 'ADAPTER_IDENTITY_CHANGED')
            need(ruflo_identity is not None, 'RUFLO_IDENTITY_UNACKNOWLEDGED')
            current = inspect(ruflo_identity[0])
            need(current is None or current == ruflo_identity, 'RUFLO_IDENTITY_CHANGED')
            if current is not None:
                send_signal(ruflo_identity[0], signal.SIGTERM)
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                need(inspect(child.pid) == adapter_identity, 'ADAPTER_IDENTITY_CHANGED')
                current = inspect(ruflo_identity[0])
                need(current is None or current == ruflo_identity, 'RUFLO_IDENTITY_CHANGED')
                if current is not None:
                    send_signal(ruflo_identity[0], signal.SIGKILL)
                child.kill()
                child.wait(timeout=3)
        result['exit_code'] = child.poll()
        result['adapter_absent'] = inspect(child.pid) is None
        result['ruflo_absent'] = ruflo_identity is not None and inspect(ruflo_identity[0]) is None
        result['safe'] = (result['adapter_absent'] and result['ruflo_absent']
                          and result['exit_code'] == 0 and not result['forced'] and 'error' not in result)
    except Exception as error:
        result['error'] = str(error) if isinstance(error, SmokeError) else type(error).__name__
    return result


def read_frames(stream, destination):
    try:
        while True:
            line = stream.readline(FRAME_LIMIT + 2)
            if not line:
                destination.put_nowait(SmokeError('TRANSPORT_EOF'))
                return
            need(len(line) <= FRAME_LIMIT and line.endswith(b'\n'), 'INVALID_OR_OVERSIZED_FRAME')
            value = json.loads(line)
            need(isinstance(value, dict) and value.get('jsonrpc') == '2.0', 'INVALID_FRAME')
            destination.put_nowait(value)
    except Exception as error:
        try:
            destination.put_nowait(error if isinstance(error, SmokeError) else SmokeError('INVALID_FRAME'))
        except queue.Full:
            pass  # request deadline still fails closed; the queue is bounded


class Session:
    def __init__(self, checked, number, record):
        self.number, self.serial, self.record = number, 0, record
        self.adapter_identity = self.ruflo_identity = None
        self.process = {'session': number, 'started': False, 'completed': False}
        self.child = subprocess.Popen([str(checked['node']), str(checked['adapter'])],
            cwd=checked['state'], env=checked['env'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        # No fallible work after spawn: caller registers the returned handle first.
        self.process.update(started=True, pid=self.child.pid)

    def start(self):
        self.adapter_identity = process_identity(self.child.pid)
        need(self.adapter_identity is not None and self.adapter_identity[1] == os.getpid()
             and self.adapter_identity[2] == self.child.pid, 'ADAPTER_IDENTITY_UNKNOWN')
        self.process['adapter_identity'] = self.adapter_identity
        self.lines = queue.Queue(maxsize=128)
        self.reader = threading.Thread(target=read_frames, args=(self.child.stdout, self.lines), daemon=True)
        self.reader.start()
        # Drain but never persist upstream diagnostic text or ambient identifiers.
        self.stderr_bytes = 0
        def drain():
            while True:
                chunk = self.child.stderr.read(4096)
                if not chunk:
                    return
                self.stderr_bytes += len(chunk)
        self.stderr_reader = threading.Thread(target=drain, daemon=True)
        self.stderr_reader.start()
        init = self.request('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'sd-fixed-extension-transport-check', 'version': '2'}})
        need(init.get('serverInfo') == {'name': 'ruflo', 'version': '3.75.0'}
             and init.get('protocolVersion') == '2025-11-25'
             and init.get('capabilities') == {'tools': {'listChanged': True}}, 'WRONG_SERVER_IDENTITY')
        self.notify('notifications/initialized', {})
        inventory = self.request('tools/list', {}).get('tools')
        need(isinstance(inventory, list), 'WRONG_TOOL_INVENTORY')
        names = [t.get('name') if isinstance(t, dict) else None for t in inventory]
        need(len(names) == 13 and set(names) == TOOLS, 'WRONG_TOOL_INVENTORY')
        status = self.call('mcp_status', {})
        need(status.get('running') is True and status.get('transport') == 'stdio', 'WRONG_SERVER_STATUS')
        pid = status.get('pid')
        need(type(pid) is int and pid != self.child.pid, 'INVALID_PROCESS_PID')
        child_key = process_identity(pid)
        need(process_identity(self.child.pid) == self.adapter_identity and child_key is not None
             and child_key[1] == self.child.pid and child_key[2] == self.child.pid, 'RUFLO_NOT_OWNED_DIRECT_CHILD')
        self.ruflo_identity = child_key
        self.process['ruflo_identity'] = child_key
        denied = self.request('tools/call', {'name': '__local_forbidden_probe__', 'arguments': {}}, denial=True)
        need(denied == {'code': -32602, 'message': 'Tool is outside the local coordination profile'}, 'UNLISTED_TOOL_ACCEPTED')
        self.process['filtered_inventory_and_denial'] = True

    def notify(self, method, params):
        self.child.stdin.write((json.dumps({'jsonrpc': '2.0', 'method': method, 'params': params}) + '\n').encode())
        self.child.stdin.flush()

    def request(self, method, params, *, denial=False):
        self.serial += 1
        request_id = self.serial
        self.record({'session': self.number, 'direction': 'request', 'id': request_id,
                     'method': method, 'tool': params.get('name')})
        self.child.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': request_id,
            'method': method, 'params': params}) + '\n').encode())
        self.child.stdin.flush()
        deadline = time.monotonic() + 40
        while True:
            remaining = deadline - time.monotonic()
            need(remaining > 0, 'RESPONSE_TIMEOUT_NO_RETRY')
            try:
                response = self.lines.get(timeout=remaining)
            except queue.Empty:
                raise SmokeError('RESPONSE_TIMEOUT_NO_RETRY') from None
            if isinstance(response, Exception):
                raise response
            if 'id' not in response:
                need(response.get('method') in ('notifications/tools/list_changed', 'notifications/progress', 'notifications/message'), 'UNEXPECTED_CALLBACK')
                continue
            need(type(response['id']) is int and response['id'] == request_id
                 and ('error' in response) != ('result' in response), 'UNEXPECTED_RESPONSE')
            self.record({'session': self.number, 'direction': 'response', 'id': request_id,
                         'accepted': 'error' not in response})
            if denial:
                need(isinstance(response.get('error'), dict), 'EXPECTED_DENIAL_MISSING')
                return response['error']
            need('error' not in response and isinstance(response.get('result'), dict), 'RPC_RESPONSE_REJECTED')
            return response['result']

    def call(self, name, arguments):
        need(name in TOOLS, 'UNLISTED_CALL')
        result = self.request('tools/call', {'name': name, 'arguments': arguments})
        content = result.get('content')
        need(result.get('isError') is False and isinstance(content, list) and len(content) == 1
             and content[0].get('type') == 'text', 'TOOL_RESPONSE_REJECTED')
        value = json.loads(content[0]['text'])
        need(isinstance(value, dict) and value.get('success') is not False and not value.get('error'), 'TOOL_RESPONSE_REJECTED')
        return value

    def close(self):
        result = cleanup_process(self.child, self.adapter_identity, self.ruflo_identity,
                                 inspect=process_identity, send_signal=os.kill)
        for attr in ('reader', 'stderr_reader'):
            thread = getattr(self, attr, None)
            if thread:
                thread.join(timeout=1)
        self.process['cleanup'] = result
        self.process['completed'] = result['safe']
        return result


def acknowledged(name, args, value):
    need(value.get('success') is True, 'MUTATION_NOT_ACKNOWLEDGED')
    if name == 'team_create':
        need(value.get('action') == 'create' and value.get('team', {}).get('id') == args['name'], 'MUTATION_NOT_ACKNOWLEDGED')
    elif name == 'team_spawn':
        need(value.get('action') == 'spawn' and value.get('teamId') == args['team']
             and value.get('spawnPlan', {}).get('name') == args['agent'], 'MUTATION_NOT_ACKNOWLEDGED')
    elif name == 'team_send':
        message = value.get('message', {})
        need(value.get('action') == 'send' and value.get('recipients') == [args['to']]
             and all(message.get(k) == v for k, v in {'teamId': args['team'], 'to': args['to'],
                 'from': args['from'], 'content': args['message']}.items()), 'MUTATION_NOT_ACKNOWLEDGED')
    elif name == 'team_shutdown':
        need(value.get('action') == 'shutdown' and value.get('teamId') == args['team'], 'MUTATION_NOT_ACKNOWLEDGED')


def run_smoke(checked, *, session_factory, nonce_factory, preservation_check):
    """No optional execution seam: fake callers cannot fall back to real ports."""
    state = checked['state']
    no_live_state(state)
    lock = HeldFile(state / 'extension-setup.lock')
    area = None
    sessions, link = [], None
    report = {'status': 'IN_PROGRESS', 'actual_claude_extension_acknowledged': False,
              'external_models_requested': False, 'network_sandbox_claimed': False,
              'clients_requested': 2, 'clients_started': 0, 'clients_completed': 0,
              'clients_attempted': 0, 'spawn_unresolved': False,
              'mutations': [], 'unknown_mutation': False, 'processes': [],
              'input_hashes': checked['input_hashes'], 'profile_sha256': checked['profile_sha256']}
    first_error = None
    test_created = test_closed = False
    protocol = report_file = None
    link_value = None
    try:
        no_live_state(state)
        run_id = nonce_factory()
        need(isinstance(run_id, str) and len(run_id) == 32 and all(c in '0123456789abcdef' for c in run_id), 'INVALID_NONCE')
        lock.write({'run_id': run_id, 'status': 'IN_PROGRESS', 'models_requested': False})
        area = state / ('local-extension-smoke-' + run_id)
        area.mkdir(mode=0o700)
        area_key = identity(area)
        report['artifact_directory'] = str(area)
        report_file = HeldFile(area / 'report.json')
        protocol = HeldFile(area / 'protocol.json')
        events = []
        def save():
            need(identity(area) == area_key, 'EVIDENCE_DIRECTORY_REPLACED')
            report_file.write(report)
        def record(event):
            need(identity(area) == area_key, 'EVIDENCE_DIRECTORY_REPLACED')
            events.append(event)
            protocol.write(events)
        def client(number):
            report['clients_attempted'] += 1
            save()
            try:
                s = session_factory(checked, number, record)
            except Exception:
                report['spawn_unresolved'] = True
                raise SmokeError('SPAWN_OUTCOME_UNRESOLVED') from None
            sessions.append(s)
            report['processes'].append(s.process)
            report['clients_started'] += 1
            save()
            s.start()
            return s
        def mutate(s, name, args):
            report['mutations'].append({'tool': name, 'team': args.get('team', args.get('name')), 'acknowledged': False})
            save()
            try:
                value = s.call(name, args)
                acknowledged(name, args, value)
            except Exception:
                report['unknown_mutation'] = True
                save()
                raise SmokeError('UNRESOLVED_MUTATION_NO_RETRY') from None
            report['mutations'][-1]['acknowledged'] = True
            save()
            return value
        def member(s, team, agent, role):
            mutate(s, 'team_spawn', {'team': team, 'agent': agent, 'role': role,
                'prompt': 'Existing local participant metadata only. Do not start a model worker.'})
        def send(s, team, sender, recipient, content):
            mutate(s, 'team_send', {'team': team, 'from': sender, 'to': recipient, 'message': content})
        def contains(s, team, agent, sender, content):
            value = s.call('team_inbox', {'team': team, 'agent': agent, 'peek': True})
            need(value.get('team') == team and value.get('agent') == agent and value.get('peek') is True
                 and any(all(m.get(k) == v for k, v in {'teamId': team, 'to': agent,
                     'from': sender, 'content': content}.items()) for m in value.get('messages', [])
                         if isinstance(m, dict)), 'MAILBOX_ROUNDTRIP_MISMATCH')
        first = client(1)
        second = client(2)
        test_team = 'sd-link-check-' + run_id
        absent(team_path(state, test_team))
        mutate(first, 'team_create', {'name': test_team, 'host': 'codex', 'maxAgents': 2, 'topology': 'hierarchical'})
        test_created = True
        member(first, test_team, 'test-client-a', 'reviewer')
        member(first, test_team, 'test-client-b', 'reviewer')
        challenge = 'synthetic-local-bus-' + run_id
        send(first, test_team, 'test-client-a', 'test-client-b', challenge)
        contains(second, test_team, 'test-client-b', 'test-client-a', challenge)
        send(second, test_team, 'test-client-b', 'test-client-a', 'ACK:' + challenge)
        contains(first, test_team, 'test-client-a', 'test-client-b', 'ACK:' + challenge)
        mutate(first, 'team_shutdown', {'team': test_team})
        test_closed = True
        report['test_team'] = test_team
        report['two_client_mailbox_roundtrip'] = True
        no_live_state(state)
        link = HeldFile(state / 'extension-link.json')
        link_value = {'schema': 'sd-local-extension-link-v2', 'run_id': run_id, 'team': LIVE_TEAM,
            'codex_agent': 'codex-lead', 'claude_agent': 'claude-reviewer', 'nonce': run_id,
            'expected_reply': 'CLAUDE_EXTENSION_ACK:' + run_id,
            'status': 'RESERVED_PARTIAL_SETUP', 'actual_claude_extension_acknowledged': False,
            'external_models_requested': False}
        link.write(link_value)
        absent(team_path(state, LIVE_TEAM))
        mutate(first, 'team_create', {'name': LIVE_TEAM, 'host': 'codex', 'maxAgents': 4, 'topology': 'hierarchical'})
        member(first, LIVE_TEAM, 'codex-lead', 'coordinator')
        member(first, LIVE_TEAM, 'claude-reviewer', 'reviewer')
        send(first, LIVE_TEAM, 'codex-lead', 'claude-reviewer', json.dumps({
            'purpose': 'connectivity-only; no implementation, approvals, app tests, providers or Docker',
            'nonce': run_id, 'reply_to': 'codex-lead', 'expected_reply': 'CLAUDE_EXTENSION_ACK:' + run_id}, sort_keys=True))
        report['live_challenge_queued'] = True
    except Exception as error:
        first_error = str(error) if isinstance(error, SmokeError) else type(error).__name__
    finally:
        if test_created and not test_closed and not report['unknown_mutation']:
            try:
                mutate(sessions[0], 'team_shutdown', {'team': test_team})
                test_closed = True
            except Exception as error:
                first_error = first_error or str(error)
        cleanup_ok = not report['spawn_unresolved']
        for s in reversed(sessions):
            try:
                cleanup = s.close()
                cleanup_ok = cleanup_ok and cleanup['safe'] is True
            except Exception:
                cleanup_ok = False
            report['clients_completed'] += int(s.process.get('completed') is True)
        try:
            preservation_check()
            report['frozen_sources_preserved'] = True
        except Exception:
            first_error = first_error or 'FROZEN_SOURCE_PRESERVATION_FAILED'
        report['first_failure'] = first_error
        report['status'] = ('UNRESOLVED_PROCESS_CLEANUP' if not cleanup_ok else
            'UNRESOLVED_MUTATION' if report['unknown_mutation'] else 'FAIL' if first_error else
            'LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK')
        try:
            if link is not None and link_value is not None:
                link_value['status'] = report['status']
                link_value['local_transport_test'] = 'PASS' if report['status'] == 'LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK' else 'UNRESOLVED'
                link.write(link_value)
            if report_file is not None:
                save()
            if report['status'] == 'LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK':
                lock.release()
        except Exception:
            report['first_failure'] = first_error or 'EVIDENCE_OR_RESERVATION_REPLACED'
            report['status'] = 'UNRESOLVED_PROCESS_CLEANUP' if not cleanup_ok else 'UNRESOLVED_STATE_WRITE'
            try:
                if report_file is not None:
                    save()
            except Exception:
                pass  # never write through a replaced evidence identity
        for held in (protocol, report_file, link, lock):
            if held is not None:
                held.close()
    return report


def preservation():
    archive = ROOT / 'documentation/planning/implementation/handover/2026-11-10-local-extensions'
    manifest = regular(archive / 'artifacts.sha256.json')
    need(digest(manifest) == '8db501e58ccb11df861273392228c947668c6fe477f7fee43a03a170a45acff5', 'ARCHIVE_MANIFEST_CHANGED')
    for name, expected in json.loads(manifest).items():
        need(Path(name).name == name and digest(regular(archive / name)) == expected, 'ARCHIVE_CHANGED')
    frozen = json.loads(regular(archive / 'review-input.json'))
    for name, expected in frozen['files_sha256'].items():
        need(digest(regular(ROOT / name)) == expected, 'STAGED_SOURCE_CHANGED')
    for name, expected in {'SESSION_HANDOVER.md': 'a3506a23605ac1092eada9c3c9c1bf194f56873b8100275a96beea15d07314ca',
                           'START_NEXT_SESSION.txt': 'a5770aeea5f8c10d0c657da3e2389e2c6acd3bba22a436a7256acf86b6ad5e7b'}.items():
        need(digest(regular(ROOT / 'documentation/planning/implementation' / name)) == expected, 'HANDOVER_CHANGED')
    patch = subprocess.check_output(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
        'diff', '--cached', '--binary', '--full-index'], cwd=ROOT, env={'PATH': '/usr/bin:/bin'})
    need(digest(patch) == frozen['patch_sha256'], 'STAGED_PATCH_CHANGED')


def read_fixed_inputs():
    preservation()
    return admit(pins=PINS, node=NODE, adapter=INSTALLED, state=STATE, environment=ENV,
        codex=tomllib.loads(regular(HOME / '.codex/config.toml').decode())['mcp_servers']['ruflo'],
        claude=json.loads(regular(HOME / '.claude.json'))['mcpServers']['ruflo'],
        package=json.loads(regular(CLI / 'package.json')))


def main():
    # This invocation requires two later exact source/recipe reviews. It never
    # installs/configures, starts hosted workers or submits a Claude prompt.
    try:
        need(len(sys.argv) == 1, 'NO_ARGUMENTS_ALLOWED')
        checked = read_fixed_inputs()
    except Exception as error:
        print(json.dumps({'status': 'PRELAUNCH_REJECTED', 'clients_started': 0,
            'actual_claude_extension_acknowledged': False,
            'first_failure': str(error) if isinstance(error, SmokeError) else type(error).__name__}))
        return 1
    def fixed_session(inputs, number, record):
        # Both clients revalidate before Popen. The second cannot inherit stale
        # admission after the first client started. No test seam calls this.
        fresh = read_fixed_inputs()
        need(fresh == inputs, 'FIXED_INPUTS_DRIFTED')
        return Session(fresh, number, record)
    report = run_smoke(checked, session_factory=fixed_session, nonce_factory=lambda: uuid.uuid4().hex,
                       preservation_check=preservation)
    print(json.dumps({k: report[k] for k in ('status', 'clients_requested', 'clients_started',
        'clients_completed', 'actual_claude_extension_acknowledged', 'first_failure')}))
    return 0 if report['status'] == 'LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'UNRESOLVED_RUN_STATE', 'clients_started': None,
            'actual_claude_extension_acknowledged': False,
            'first_failure': str(error) if isinstance(error, SmokeError) else type(error).__name__}))
        sys.exit(1)

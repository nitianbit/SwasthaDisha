"""Bounded local persistence check for the installed Ruflo stdio profile."""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import tomllib
import uuid

CONFIG = Path('/Users/shubham/.codex/config.toml')
STATE = Path('/Users/shubham/.codex/ruflo-state/swasthadisha')
profile = tomllib.loads(CONFIG.read_text())['mcp_servers']['ruflo']
assert profile['cwd'] == str(STATE)
assert profile['env']['CLAUDE_FLOW_CWD'] == str(STATE)
assert (STATE / 'config/ruflo/policy-trust').is_dir()
assert profile['env']['RUFLO_DAEMON_AUTOSTART'] == '0'
assert profile['env']['CLAUDE_FLOW_DISABLE_BRIDGE'] == '1'
enabled = set(profile['enabled_tools'])
assert enabled == {
    'mcp_status', 'system_health', 'team_create', 'team_spawn', 'team_send',
    'team_inbox', 'team_status', 'team_shutdown', 'task_create', 'task_status',
    'task_list', 'task_update', 'task_complete',
}
area = STATE / ('install-smoke-' + time.strftime('%Y%m%dT%H%M%S', time.gmtime()) + '-' + uuid.uuid4().hex[:8])
area.mkdir(mode=0o700)
protocol = (area / 'protocol.jsonl').open('x')
os.chmod(area / 'protocol.jsonl', 0o600)
report = {
    'status': 'IN_PROGRESS', 'artifact_directory': str(area),
    'profile_sha256': hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest(),
    'runtime': 'ruflo@3.75.0', 'tool_calls': [], 'processes': [],
    'external_models_requested': False, 'network_sandbox_claimed': False,
    'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
}
children = []

def save():
    (area / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    os.chmod(area / 'report.json', 0o600)

def record(direction, data, session):
    protocol.write(json.dumps({'session': session, 'direction': direction, 'message': data}) + '\n')
    protocol.flush()

class Session:
    def __init__(self, number):
        self.number, self.serial = number, 0
        self.lines = queue.Queue()
        self.stderr = (area / ('session-' + str(number) + '.stderr.txt')).open('x')
        env = {'PATH': str(Path(profile['command']).parent) + ':/usr/bin:/bin', **profile['env']}
        assert not any(k in env for k in ('ANTHROPIC_API_KEY','OPENAI_API_KEY','AWS_ACCESS_KEY_ID','GITHUB_TOKEN','HF_TOKEN'))
        self.child = subprocess.Popen(
            [profile['command'], *profile['args']], cwd=STATE, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
            text=True, bufsize=1,
        )
        children.append(self)
        self.process = {'session': number, 'pid': self.child.pid, 'exit_code': None, 'stdin_closed': False}
        report['processes'].append(self.process); save()
        def reader():
            try:
                for line in self.child.stdout:
                    self.lines.put(line)
            finally:
                self.lines.put(None)
        self.reader = threading.Thread(target=reader, daemon=True)
        self.reader.start()
        init = self.request('initialize', {
            'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'swasthadisha-install-check', 'version': '1'},
        })
        assert init['serverInfo'] == {'name': 'ruflo', 'version': '3.75.0'}, init
        assert init['protocolVersion'] == '2025-11-25'
        self.notify('notifications/initialized', {})
        listed = self.request('tools/list', {})
        names = [item['name'] for item in listed['tools']]
        assert len(names) == len(set(names))
        assert enabled.issubset(names), enabled.difference(names)
        self.process['advertised_tools'] = len(names)
        self.process['all_13_enabled_tools_exist'] = True; save()

    def request(self, method, params):
        self.serial += 1
        message = {'jsonrpc': '2.0', 'id': self.serial, 'method': method, 'params': params}
        record('request', message, self.number)
        self.child.stdin.write(json.dumps(message) + '\n'); self.child.stdin.flush()
        deadline = time.monotonic() + 40
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('No response within 40 seconds; no mutation retry')
            line = self.lines.get(timeout=remaining)
            if line is None:
                raise RuntimeError('Server stdout closed before response')
            response = json.loads(line)
            record('response', response, self.number)
            if response.get('id') != self.serial:
                assert 'id' not in response, response
                continue
            assert 'error' not in response, response
            return response['result']

    def notify(self, method, params):
        message = {'jsonrpc': '2.0', 'method': method, 'params': params}
        record('request', message, self.number)
        self.child.stdin.write(json.dumps(message) + '\n'); self.child.stdin.flush()

    def call(self, name, arguments):
        assert name in enabled
        result = self.request('tools/call', {'name': name, 'arguments': arguments})
        assert result.get('isError') is False, result
        texts = [part['text'] for part in result['content'] if part['type'] == 'text']
        assert len(texts) == 1
        value = json.loads(texts[0])
        assert not (isinstance(value, dict) and (value.get('success') is False or value.get('error'))), value
        report['tool_calls'].append({'session': self.number, 'tool': name, 'arguments': arguments, 'result': value})
        save(); return value

    def close(self):
        if self.child.stdin and not self.child.stdin.closed:
            self.child.stdin.close(); self.process['stdin_closed'] = True
        try:
            self.process['exit_code'] = self.child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process['forced_termination'] = True
            self.child.terminate()
            try:
                self.process['exit_code'] = self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill(); self.process['exit_code'] = self.child.wait(timeout=5)
        self.reader.join(timeout=2)
        self.process['exact_child_absent'] = self.child.poll() is not None
        self.stderr.close(); save()
        assert self.process['exit_code'] == 0 and not self.process.get('forced_termination'), self.process

save()
print(json.dumps({'phase': 'local-mcp-check', 'artifacts': str(area)}), flush=True)
try:
    first = Session(1)
    status = first.call('mcp_status', {})
    assert status['running'] is True and status['transport'] == 'stdio' and status['pid'] == first.child.pid
    created = first.call('task_create', {'type': 'research', 'description': 'Local Ruflo install persistence check; no application, provider or model execution.', 'tags': ['install-check']})
    task_id = created['taskId']; report['task_id'] = task_id
    assert created['status'] == 'pending'
    first.close()
    second = Session(2)
    persisted = second.call('task_status', {'taskId': task_id})
    assert persisted['status'] == 'pending' and persisted['taskId'] == task_id
    completed = second.call('task_complete', {'taskId': task_id, 'result': {'check': 'local-install-only', 'persisted_across_mcp_restart': True}})
    assert completed['status'] == 'completed'
    checked = second.call('task_status', {'taskId': task_id})
    assert checked['status'] == 'completed' and checked['progress'] == 100
    second.close()
    store = json.loads((STATE / '.claude-flow/tasks/store.json').read_text())
    assert store['tasks'][task_id]['status'] == 'completed'
    assert store['tasks'][task_id]['result']['persisted_across_mcp_restart'] is True
    report['task_persisted_across_restart'] = True
    report['exact_children_absent'] = all(s.child.poll() is not None for s in children)
    report['status'] = 'PASS'
except Exception as error:
    report['status'] = 'FAIL'
    report['error'] = {'type': type(error).__name__, 'message': str(error)}
    for session in children:
        if session.child.poll() is None:
            try:
                session.close()
            except Exception as close_error:
                session.process['cleanup_error'] = str(close_error)
    report['exact_children_absent'] = all(s.child.poll() is not None for s in children)
finally:
    report['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    save(); protocol.close()
    print(json.dumps({key: report.get(key) for key in ['status','artifact_directory','task_id','task_persisted_across_restart','exact_children_absent','error']}), flush=True)

if report['status'] != 'PASS':
    raise SystemExit(1)

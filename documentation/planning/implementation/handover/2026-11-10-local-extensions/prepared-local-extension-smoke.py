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
area = STATE / ('local-extension-smoke-' + time.strftime('%Y%m%dT%H%M%S', time.gmtime()) + '-' + uuid.uuid4().hex[:8])
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


report['actual_claude_extension_acknowledged'] = False
report['test_client_scope'] = 'two direct local MCP clients, not two model extensions'
report['denied_unlisted_calls'] = 0
save()
print(json.dumps({'phase':'local-extension-bus-check','artifacts':str(area)}),flush=True)
try:
    first = Session(1)
    assert first.process['advertised_tools'] == 13
    first_status = first.call('mcp_status', {})
    assert first_status['running'] is True and first_status['transport'] == 'stdio'
    first.process['ruflo_pid'] = first_status['pid']
    try:
        first.request('tools/call', {'name':'__local_forbidden_probe__','arguments':{}})
        raise RuntimeError('Unlisted tool was accepted')
    except AssertionError as denial:
        response=denial.args[0]
        assert response['error']['code']==-32602
        assert response['error']['message']=='Tool is outside the local coordination profile'
        report['denied_unlisted_calls'] += 1
    test_team='sd-link-check-'+uuid.uuid4().hex[:8]
    challenge='local-bus-'+uuid.uuid4().hex
    first.call('team_create',{'name':test_team,'host':'codex','maxAgents':2,'topology':'hierarchical'})
    for name in ['test-client-a','test-client-b']:
        first.call('team_spawn',{'team':test_team,'agent':name,'role':'reviewer','prompt':'Local mailbox transport check only; metadata registration; no worker execution.'})
    first.call('team_send',{'team':test_team,'to':'test-client-b','from':'test-client-a','message':challenge})
    second=Session(2)
    assert second.process['advertised_tools']==13
    second_status=second.call('mcp_status',{})
    second.process['ruflo_pid']=second_status['pid']
    received=second.call('team_inbox',{'team':test_team,'agent':'test-client-b','peek':True})
    assert challenge in json.dumps(received)
    reply='ACK:'+challenge
    second.call('team_send',{'team':test_team,'to':'test-client-a','from':'test-client-b','message':reply})
    checked=first.call('team_inbox',{'team':test_team,'agent':'test-client-a','peek':True})
    assert reply in json.dumps(checked)
    first.call('team_shutdown',{'team':test_team})
    report['two_client_mailbox_roundtrip']=True
    report['test_team']=test_team
    team='swasthadisha-local'
    first.call('team_create',{'name':team,'host':'codex','maxAgents':4,'topology':'hierarchical'})
    for name,role in [('codex-lead','coordinator'),('claude-reviewer','reviewer')]:
        first.call('team_spawn',{'team':team,'agent':name,'role':role,'prompt':'Existing local extension participant only. Register metadata; do not start any model worker.'})
    nonce=uuid.uuid4().hex
    first.call('team_send',{'team':team,'to':'claude-reviewer','from':'codex-lead','type':'status','summary':'Local extension connection check',
      'message':json.dumps({'purpose':'connectivity-only; no implementation, approval, file edits, app tests, providers or Docker','nonce':nonce,'reply_to':'codex-lead','expected_reply':'CLAUDE_EXTENSION_ACK:'+nonce})})
    first.call('team_status',{'team':team})
    link={'team':team,'codex_agent':'codex-lead','claude_agent':'claude-reviewer','nonce':nonce,'expected_reply':'CLAUDE_EXTENSION_ACK:'+nonce,'status':'PENDING_CLAUDE_EXTENSION_ACK','created_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'local_transport_test':'PASS','actual_claude_extension_acknowledged':False,'native_codex_worker_handshake':'PASS /root/codex_connection_check at 5aecb5578869995063eabad5bc5a4c95c79f017b'}
    link_path=STATE/'extension-link.json'
    assert not link_path.exists(),'Existing link must not be overwritten'
    link_path.write_text(json.dumps(link,indent=2)+'\n');os.chmod(link_path,0o600)
    report['live_link_state']=str(link_path)
    second.close();first.close()
    report['exact_children_absent']=all(s.child.poll() is not None for s in children)
    report['status']='PASS'
except Exception as error:
    report['status']='FAIL';report['error']={'type':type(error).__name__,'message':str(error)}
    for session in children:
        if session.child.poll() is None:
            try: session.close()
            except Exception as close_error: session.process['cleanup_error']=str(close_error)
finally:
    report['finished_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime());save();protocol.close()
    print(json.dumps({key:report.get(key) for key in ['status','artifact_directory','two_client_mailbox_roundtrip','denied_unlisted_calls','actual_claude_extension_acknowledged','error']}),flush=True)
if report['status']!='PASS':raise SystemExit(1)

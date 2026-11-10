"""Offline fake-port checks. No real Ruflo, model, Docker or app execution."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('reviewed_smoke', ROOT / 'tools/agents/ruflo-extension-smoke.py')
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


def forbidden(*args, **kwargs):
    raise AssertionError('REAL_PROCESS_PORT_FORBIDDEN_IN_OFFLINE_TESTS')


class Fixture:
    def __init__(self, root):
        self.state = root / 'state'
        self.state.mkdir()
        self.node = root / 'node'
        self.adapter = root / 'adapter.mjs'
        self.node.write_bytes(b'fake-node-never-executed')
        self.adapter.write_bytes(b'fake-adapter-never-executed')
        self.environment = {'CLAUDE_FLOW_CWD': str(self.state)}
        self.codex = {'command': str(self.node), 'args': [str(self.adapter)], 'cwd': str(self.state),
                      'env': self.environment.copy(), 'enabled_tools': sorted(smoke.TOOLS)}
        self.claude = {'type': 'stdio', 'command': str(self.node), 'args': [str(self.adapter)]}
        self.pins = {p: smoke.digest(p.read_bytes()) for p in (self.node, self.adapter)}

    def admit(self, **changes):
        data = dict(pins=self.pins, node=self.node, adapter=self.adapter, state=self.state,
                    environment=self.environment, codex=self.codex, claude=self.claude,
                    package={'version': '3.75.0'})
        data.update(changes)
        return smoke.admit(**data)


class FakeBus:
    def __init__(self, fixture, failure=None, cleanup=False, start_failure=False):
        self.fixture, self.failure, self.cleanup, self.start_failure = fixture, failure, cleanup, start_failure
        self.teams, self.calls, self.sessions = {}, [], []

    def session(self, checked, number, record):
        bus = self
        class FakeSession:
            def __init__(self):
                self.process = {'session': number, 'started': True, 'completed': False}
            def start(self):
                if bus.start_failure:
                    raise smoke.SmokeError('ORIGINAL_START_FAILURE')
                self.process['filtered_inventory_and_denial'] = True
            def call(self, name, args):
                bus.calls.append((number, name, copy.deepcopy(args)))
                if bus.failure == name:
                    raise TimeoutError('No response, unknown mutation; never retry')
                if bus.failure == 'ambiguous-create' and name == 'team_create':
                    return {'success': True, 'action': 'create', 'team': {'id': 'wrong'}}
                if name == 'team_create':
                    bus.teams[args['name']] = {'members': {}, 'mail': {}, 'closed': False}
                    path = smoke.team_path(bus.fixture.state, args['name'])
                    path.mkdir(parents=True)
                    return {'success': True, 'action': 'create', 'team': {'id': args['name']}}
                team = bus.teams[args['team']]
                if name == 'team_spawn':
                    team['members'][args['agent']] = args['role']
                    return {'success': True, 'action': 'spawn', 'teamId': args['team'], 'spawnPlan': {'name': args['agent']}}
                if name == 'team_send':
                    msg = {'teamId': args['team'], 'to': args['to'], 'from': args['from'], 'content': args['message']}
                    team['mail'].setdefault(args['to'], []).append(msg)
                    return {'success': True, 'action': 'send', 'message': msg, 'recipients': [args['to']]}
                if name == 'team_inbox':
                    messages = team['mail'].get(args['agent'], [])
                    if bus.failure == 'mail-mismatch':
                        messages = [{'content': 'prefix ' + m['content']} for m in messages]
                    return {'success': True, 'team': args['team'], 'agent': args['agent'], 'peek': True, 'messages': messages}
                if name == 'team_shutdown':
                    team['closed'] = True
                    return {'success': True, 'action': 'shutdown', 'teamId': args['team']}
                raise AssertionError(name)
            def close(self):
                safe = not bus.cleanup
                self.process['completed'] = safe
                self.process['cleanup'] = {'safe': safe}
                return {'safe': safe}
        result = FakeSession()
        self.sessions.append(result)
        return result


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sd-ruflo-fake-')
        self.addCleanup(self.temp.cleanup)
        self.f = Fixture(Path(self.temp.name))

    def test_exact_profiles_and_pins(self):
        value = self.f.admit()
        self.assertEqual(value['env']['HOME'], '/Users/shubham')
        self.assertEqual(value['node'], self.f.node)
        self.assertEqual(len(list(self.f.state.iterdir())), 0)

    def test_bad_profiles_before_allocation(self):
        variants = []
        for label, key, value in [('direct-cli', 'args', ['cli.js', 'mcp', 'start']),
                                  ('command', 'command', '/usr/bin/node'),
                                  ('cwd', 'cwd', '/tmp'), ('env', 'env', {'ANTHROPIC_API_KEY': 'fake'})]:
            c = copy.deepcopy(self.f.codex); c[key] = value
            variants.append((label, {'codex': c}))
        for value in [[], sorted(smoke.TOOLS) + ['shell_exec'], sorted(smoke.TOOLS)[:-1], ['mcp_status'] * 13]:
            c = copy.deepcopy(self.f.codex); c['enabled_tools'] = value
            variants.append(('tools', {'codex': c}))
        for key, value in [('type', 'http'), ('command', '/usr/bin/node'), ('args', ['wrong']),
                           ('env', {'NODE_OPTIONS': '--require unsafe'}), ('url', 'https://example.invalid')]:
            c = copy.deepcopy(self.f.claude); c[key] = value
            variants.append(('claude-' + key, {'claude': c}))
        variants.append(('version', {'package': {'version': '4'}}))
        for label, changes in variants:
            with self.subTest(label=label), self.assertRaises(smoke.SmokeError):
                self.f.admit(**changes)
            self.assertEqual(list(self.f.state.iterdir()), [])

    def test_wrong_pin_and_symlink(self):
        self.f.node.write_bytes(b'changed')
        with self.assertRaisesRegex(smoke.SmokeError, 'HASH'):
            self.f.admit()
        self.f.node.unlink()
        self.f.node.symlink_to(self.f.adapter)
        with self.assertRaisesRegex(smoke.SmokeError, 'REGULAR'):
            self.f.admit()

    def test_codex_forwarded_environment_transport_and_auth_fields_rejected(self):
        for key, value in [('env_vars', ['NODE_OPTIONS', 'ANTHROPIC_API_KEY']),
                           ('url', 'https://example.invalid'), ('transport', 'http'),
                           ('bearer_token_env_var', 'ANTHROPIC_API_KEY'),
                           ('http_headers', {'Authorization': 'synthetic-secret'}),
                           ('env_http_headers', {'Authorization': 'ANTHROPIC_API_KEY'}),
                           ('enabled', False), ('unknown', True)]:
            c = copy.deepcopy(self.f.codex); c[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(smoke.SmokeError, 'UNREVIEWED_CODEX_PROFILE_FIELD'):
                self.f.admit(codex=c)
            self.assertEqual(list(self.f.state.iterdir()), [])

    def test_codex_only_reviewed_bounded_timeout_controls_accepted(self):
        c = copy.deepcopy(self.f.codex)
        c.update(startup_timeout_sec=120, tool_timeout_sec=90.5)
        self.assertEqual(self.f.admit(codex=c)['node'], self.f.node)
        for value in [False, True, 0, -1, 3601, float('inf'), float('nan'), '120']:
            c['startup_timeout_sec'] = value
            with self.subTest(value=value), self.assertRaisesRegex(smoke.SmokeError, 'TIMEOUT'):
                self.f.admit(codex=c)

    def test_existing_partial_link_and_team(self):
        path = self.f.state / 'extension-link.json'
        path.symlink_to(self.f.state / 'missing')
        with self.assertRaisesRegex(smoke.SmokeError, 'PARTIAL'):
            self.f.admit()
        path.unlink()
        team = smoke.team_path(self.f.state, smoke.LIVE_TEAM)
        team.mkdir(parents=True)
        with self.assertRaisesRegex(smoke.SmokeError, 'PARTIAL'):
            self.f.admit()

    def test_symlink_state_parent(self):
        target = self.f.state / 'other'; target.mkdir()
        (self.f.state / '.claude-flow').symlink_to(target)
        with self.assertRaisesRegex(smoke.SmokeError, 'REAL_DIRECTORY'):
            self.f.admit()

    def test_exclusive_reservation_and_replacement(self):
        path = self.f.state / 'reservation'
        held = smoke.HeldFile(path)
        self.addCleanup(held.close)
        with self.assertRaises(FileExistsError):
            smoke.HeldFile(path)
        path.unlink(); path.write_text('someone else')
        with self.assertRaisesRegex(smoke.SmokeError, 'REPLACED'):
            held.write({'overwritten': True})
        with self.assertRaisesRegex(smoke.SmokeError, 'REPLACED'):
            held.release()
        self.assertEqual(path.read_text(), 'someone else')


class LifecycleTests(unittest.TestCase):
    setUp = AdmissionTests.setUp
    def run_fake(self, **kwargs):
        bus = FakeBus(self.f, **kwargs)
        report = smoke.run_smoke(self.f.admit(), session_factory=bus.session,
            nonce_factory=lambda: 'a' * 32, preservation_check=lambda: None)
        return report, bus

    def test_success_is_transport_only_and_retains_pending_link(self):
        report, bus = self.run_fake()
        self.assertEqual(report['status'], 'LOCAL_TRANSPORT_PASS_PENDING_CLAUDE_ACK')
        self.assertEqual((report['clients_started'], report['clients_completed']), (2, 2))
        self.assertFalse(report['actual_claude_extension_acknowledged'])
        self.assertFalse(report['external_models_requested'])
        link = json.loads((self.f.state / 'extension-link.json').read_text())
        self.assertFalse(link['actual_claude_extension_acknowledged'])
        self.assertEqual(link['status'], report['status'])
        self.assertFalse((self.f.state / 'extension-setup.lock').exists())
        self.assertEqual(bus.teams[smoke.LIVE_TEAM]['members'], {'codex-lead': 'coordinator', 'claude-reviewer': 'reviewer'})
        self.assertFalse(bus.teams[smoke.LIVE_TEAM]['closed'])
        self.assertTrue(bus.teams[report['test_team']]['closed'])
        self.assertTrue(all(c[1] in smoke.TOOLS for c in bus.calls))
        self.assertTrue(all(not c[2].get('force') for c in bus.calls))

    def test_timeout_never_retries_or_shuts_unknown_team(self):
        report, bus = self.run_fake(failure='team_create')
        self.assertEqual(report['status'], 'UNRESOLVED_MUTATION')
        self.assertEqual([x[1] for x in bus.calls], ['team_create'])
        self.assertFalse((self.f.state / 'extension-link.json').exists())
        self.assertTrue((self.f.state / 'extension-setup.lock').exists())

    def test_ambiguous_ack_never_grants_mutation_authority(self):
        report, bus = self.run_fake(failure='ambiguous-create')
        self.assertEqual(report['status'], 'UNRESOLVED_MUTATION')
        self.assertEqual(len(bus.calls), 1)
        self.assertFalse(report['mutations'][0]['acknowledged'])

    def test_partial_spawn_timeout_preserves_first_failure_and_state(self):
        report, bus = self.run_fake(failure='team_spawn', cleanup=True)
        self.assertEqual(report['status'], 'UNRESOLVED_PROCESS_CLEANUP')
        self.assertEqual(report['first_failure'], 'UNRESOLVED_MUTATION_NO_RETRY')
        self.assertEqual([x[1] for x in bus.calls], ['team_create', 'team_spawn'])

    def test_known_mailbox_failure_shuts_only_acknowledged_test_team(self):
        report, bus = self.run_fake(failure='mail-mismatch')
        self.assertEqual(report['status'], 'FAIL')
        self.assertEqual(report['first_failure'], 'MAILBOX_ROUNDTRIP_MISMATCH')
        shutdown = [x for x in bus.calls if x[1] == 'team_shutdown']
        self.assertEqual(len(shutdown), 1)
        self.assertNotEqual(shutdown[0][2]['team'], smoke.LIVE_TEAM)
        self.assertFalse((self.f.state / 'extension-link.json').exists())

    def test_preexisting_reservation_starts_no_client(self):
        (self.f.state / 'extension-setup.lock').write_text('existing')
        bus = FakeBus(self.f)
        with self.assertRaises(FileExistsError):
            smoke.run_smoke(self.f.admit(), session_factory=bus.session,
                nonce_factory=lambda: 'a' * 32, preservation_check=lambda: None)
        self.assertEqual(bus.sessions, [])

    def test_preexisting_team_at_execution_starts_no_client(self):
        checked = self.f.admit()
        smoke.team_path(self.f.state, smoke.LIVE_TEAM).mkdir(parents=True)
        bus = FakeBus(self.f)
        with self.assertRaises(smoke.SmokeError):
            smoke.run_smoke(checked, session_factory=bus.session,
                nonce_factory=lambda: 'a' * 32, preservation_check=lambda: None)
        self.assertEqual(bus.sessions, [])

    def test_failed_start_registered_handle_still_closes(self):
        report, bus = self.run_fake(start_failure=True)
        self.assertEqual(report['status'], 'FAIL')
        self.assertEqual(report['clients_started'], 1)
        self.assertEqual(report['clients_completed'], 1)
        self.assertEqual(report['first_failure'], 'ORIGINAL_START_FAILURE')

    def test_no_default_execution_ports(self):
        with self.assertRaises(TypeError):
            smoke.run_smoke(self.f.admit())

    def test_spawn_uncertainty_has_no_false_zero_child_cleanup(self):
        report = smoke.run_smoke(self.f.admit(), session_factory=forbidden,
            nonce_factory=lambda: 'a' * 32, preservation_check=lambda: None)
        self.assertEqual(report['status'], 'UNRESOLVED_PROCESS_CLEANUP')
        self.assertTrue(report['spawn_unresolved'])
        self.assertEqual(report['clients_started'], 0)
        self.assertEqual(report['first_failure'], 'SPAWN_OUTCOME_UNRESOLVED')


class FakeChild:
    pid = 100
    def __init__(self, *, forced=False, exit_code=0):
        self.stdin = io.BytesIO()
        self.forced, self.code = forced, exit_code
        self.waits, self.signals = [], []
    def wait(self, timeout):
        self.waits.append(timeout)
        if self.forced and not self.signals:
            raise subprocess.TimeoutExpired('synthetic-child', timeout)
        return self.code
    def terminate(self):
        self.signals.append('TERM')
    def kill(self):
        self.signals.append('KILL')
    def poll(self):
        return self.code


class ProcessAndProtocolTests(unittest.TestCase):
    def make_session(self, response):
        s = smoke.Session.__new__(smoke.Session)
        s.number, s.serial, s.record = 1, 0, lambda event: None
        s.child = SimpleNamespace(stdin=io.BytesIO())
        s.lines = queue.Queue()
        s.lines.put(response)
        return s

    def test_response_correlation_and_shape_fail_closed(self):
        for response in [{'jsonrpc': '2.0', 'id': True, 'result': {}},
                         {'jsonrpc': '2.0', 'id': 2, 'result': {}},
                         {'jsonrpc': '2.0', 'id': 1, 'result': {}, 'error': {}},
                         {'jsonrpc': '2.0', 'id': 1, 'result': []},
                         {'jsonrpc': '2.0', 'id': 1, 'error': {'message': 'synthetic-secret'}}]:
            with self.subTest(response=response), self.assertRaises(smoke.SmokeError):
                self.make_session(response).request('tools/list', {})

    def test_plain_rpc_response(self):
        self.assertEqual(self.make_session({'jsonrpc': '2.0', 'id': 1, 'result': {'tools': []}}).request('tools/list', {}), {'tools': []})

    def test_tool_envelope_rejects_error_and_multiple_content(self):
        s = smoke.Session.__new__(smoke.Session)
        for envelope in [{'isError': True, 'content': []},
                         {'isError': False, 'content': [{'type': 'text', 'text': '{"success":false}'}]},
                         {'isError': False, 'content': [{'type': 'text', 'text': '{}'}] * 2}]:
            s.request = lambda *args, **kwargs: envelope
            with self.assertRaises(smoke.SmokeError):
                s.call('team_status', {})

    def test_session_start_checks_identity_inventory_status_and_denial(self):
        initial = {'serverInfo': {'name': 'ruflo', 'version': '3.75.0'},
                   'protocolVersion': '2025-11-25', 'capabilities': {'tools': {'listChanged': True}}}
        tools = {'tools': [{'name': n} for n in sorted(smoke.TOOLS)]}
        status = {'running': True, 'transport': 'stdio', 'pid': 101}
        denial = {'code': -32602, 'message': 'Tool is outside the local coordination profile'}
        variants = [('valid', {}, {}, {}, {}, True),
                    ('server', {'serverInfo': {'name': 'other'}}, {}, {}, {}, False),
                    ('protocol', {'protocolVersion': 'old'}, {}, {}, {}, False),
                    ('capabilities', {'capabilities': {'sampling': {}}}, {}, {}, {}, False),
                    ('inventory', {}, {'tools': [{'name': 'shell_exec'}]}, {}, {}, False),
                    ('status', {}, {}, {'transport': 'http'}, {}, False),
                    ('pid', {}, {}, {'pid': True}, {}, False),
                    ('denial', {}, {}, {}, {'code': -32601}, False)]
        for label, i, t, st, d, valid in variants:
            with self.subTest(label=label):
                s = smoke.Session.__new__(smoke.Session)
                s.number, s.serial, s.record, s.process = 1, 0, lambda event: None, {}
                s.adapter_identity = s.ruflo_identity = None
                s.child = SimpleNamespace(pid=100, stdout=io.BytesIO(), stderr=io.BytesIO())
                s.notify = lambda *args: None
                def request(method, params, **kwargs):
                    if method == 'initialize': return {**initial, **i}
                    if method == 'tools/list': return {**tools, **t}
                    return {**denial, **d}
                s.request = request
                s.call = lambda *args: {**status, **st}
                def inspect(pid):
                    return (100, os.getpid(), 100, 'start') if pid == 100 else (101, 100, 100, 'start')
                with patch.object(smoke, 'process_identity', inspect):
                    if valid:
                        s.start()
                        self.assertTrue(s.process['filtered_inventory_and_denial'])
                        self.assertEqual(s.ruflo_identity, (101, 100, 100, 'start'))
                    else:
                        with self.assertRaises(smoke.SmokeError): s.start()

    def test_normal_cleanup_checks_two_distinct_absences(self):
        child = FakeChild(); seen = []
        def inspect(pid):
            seen.append(pid)
            return None
        report = smoke.cleanup_process(child, (100, 9, 100, 'start'), (101, 100, 100, 'start'), inspect=inspect, send_signal=forbidden)
        self.assertTrue(report['safe'])
        self.assertEqual(seen, [100, 101])
        self.assertGreater(child.waits[0], 7)

    def test_unknown_ruflo_child_cannot_pass(self):
        report = smoke.cleanup_process(FakeChild(), (100, 9, 100, 'start'), None, inspect=lambda pid: None, send_signal=forbidden)
        self.assertFalse(report['safe'])
        self.assertFalse(report['ruflo_absent'])

    def test_adapter_exit_does_not_prove_ruflo_exit(self):
        key = (101, 100, 100, 'start')
        report = smoke.cleanup_process(FakeChild(), (100, 9, 100, 'start'), key,
            inspect=lambda pid: key if pid == 101 else None, send_signal=forbidden)
        self.assertFalse(report['safe'])
        self.assertTrue(report['adapter_absent'])

    def test_reused_adapter_pid_prevents_signal(self):
        child = FakeChild(forced=True)
        report = smoke.cleanup_process(child, (100, 9, 100, 'old'), (101, 100, 100, 'old'),
            inspect=lambda pid: (pid, 9, 100, 'new'), send_signal=forbidden)
        self.assertFalse(report['safe'])
        self.assertEqual(report['error'], 'ADAPTER_IDENTITY_CHANGED')
        self.assertEqual(child.signals, [])

    def test_ruflo_reparenting_prevents_signal(self):
        child = FakeChild(forced=True)
        adapter = (100, 9, 100, 'old')
        report = smoke.cleanup_process(child, adapter, (101, 100, 100, 'old'),
            inspect=lambda pid: adapter if pid == 100 else (101, 1, 100, 'old'), send_signal=forbidden)
        self.assertFalse(report['safe'])
        self.assertEqual(report['error'], 'RUFLO_IDENTITY_CHANGED')
        self.assertEqual(child.signals, [])

    def test_forced_cleanup_never_passes_even_when_absent(self):
        child = FakeChild(forced=True); sent = []; adapter = (100, 9, 100, 'start'); ruflo = (101, 100, 100, 'start')
        def inspect(pid):
            if child.signals:
                return None
            return adapter if pid == 100 else ruflo
        result = smoke.cleanup_process(child, adapter, ruflo, inspect=inspect, send_signal=lambda pid, sig: sent.append((pid, sig)))
        self.assertTrue(result['adapter_absent'] and result['ruflo_absent'])
        self.assertFalse(result['safe'])
        self.assertEqual([pid for pid, _ in sent], [101])

    def test_nonzero_exit_never_passes(self):
        result = smoke.cleanup_process(FakeChild(exit_code=1), (100, 9, 100, 'start'), (101, 100, 100, 'start'),
            inspect=lambda pid: None, send_signal=forbidden)
        self.assertFalse(result['safe'])

    def test_stdin_close_failure_still_waits_and_checks_absence(self):
        child = FakeChild()
        class BrokenStdin:
            closed = False
            def close(self): raise BrokenPipeError('synthetic')
        child.stdin = BrokenStdin()
        seen = []
        def inspect(pid):
            seen.append(pid)
            return None
        result = smoke.cleanup_process(child, (100, 9, 100, 'start'), (101, 100, 100, 'start'), inspect=inspect, send_signal=forbidden)
        self.assertFalse(result['safe'])
        self.assertTrue(result['adapter_absent'] and result['ruflo_absent'])
        self.assertEqual(seen, [100, 101])
        self.assertEqual(child.waits, [9])

    def test_invalid_and_partial_frames(self):
        for data in (b'{bad}\n', b'{}\n', b'[]\n', b'{"jsonrpc":"2.0"}', b'x' * (smoke.FRAME_LIMIT + 1) + b'\n'):
            with self.subTest(length=len(data)):
                q = queue.Queue(maxsize=3)
                smoke.read_frames(io.BytesIO(data), q)
                self.assertIsInstance(q.get_nowait(), smoke.SmokeError)

    def test_valid_jsonl_frame_followed_by_eof(self):
        q = queue.Queue(maxsize=3)
        smoke.read_frames(io.BytesIO(b'{"jsonrpc":"2.0","id":1,"result":{}}\n'), q)
        self.assertEqual(q.get_nowait()['id'], 1)
        self.assertIsInstance(q.get_nowait(), smoke.SmokeError)

    def test_unlisted_call_rejected_before_request(self):
        s = smoke.Session.__new__(smoke.Session)
        s.request = forbidden
        with self.assertRaisesRegex(smoke.SmokeError, 'UNLISTED'):
            s.call('shell_exec', {})


if __name__ == '__main__':
    # Broad guard around all tests: accidental real wiring is a hard failure.
    with patch.object(subprocess, 'Popen', forbidden), patch.object(subprocess, 'run', forbidden), \
         patch.object(subprocess, 'check_output', forbidden):
        unittest.main(verbosity=2)

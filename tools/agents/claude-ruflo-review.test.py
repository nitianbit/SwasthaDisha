"""Fake-only operator checks. No real process/socket/model/user-state ports."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest


def forbidden(*args, **kwargs):
    raise AssertionError('REAL_EFFECT_PORT_DISABLED')


for name in ['Popen', 'run', 'check_output', 'check_call', 'call', 'getoutput', 'getstatusoutput']:
    setattr(subprocess, name, forbidden)
socket.socket = forbidden
socket.create_connection = forbidden
os.kill = forbidden
os.killpg = forbidden
os.system = forbidden
spec = importlib.util.spec_from_file_location('owned_review', Path(__file__).with_name('claude-ruflo-review.py'))
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
original_collect = m.RealPorts.collect
for name in ['command', 'admit', 'auth', 'auth_start', 'auth_capture', 'auth_close', 'revalidate', 'reserve', 'start', 'collect',
             'identity', 'child_pids', 'group_empty', 'observe', 'close_input',
             'wait_grace', 'signal_exact', 'private_write', 'save', 'finish']:
    setattr(m.RealPorts, name, forbidden)
original_load_fixed = m.load_fixed
m.load_fixed = forbidden
m.preservation = forbidden
original_regular = m.regular
allowed_test_root = None


def guarded_regular(path, **kwargs):
    p = Path(path).absolute()
    if allowed_test_root is None or not p.is_relative_to(allowed_test_root):
        raise AssertionError('REAL_STATE_PORT_DISABLED')
    return original_regular(path, **kwargs)


m.regular = guarded_regular
SID = '6eed447b-86b2-4259-9235-08875d6bc9a3'
LINK = {'nonce': 'fixture-nonce', 'expected_reply': 'CLAUDE_EXTENSION_ACK:fixture-nonce'}
START = 'Wed Nov 11 01:50:00 2026'
CLI_ID = m.Identity(100, 10, 100, START, m.CLI)
ADAPTER_ID = m.Identity(101, 100, 100, START, m.NODE)
RUFLO_ID = m.Identity(102, 101, 100, START, m.NODE)
CAPTURED = {'cli': CLI_ID, 'adapter': ADAPTER_ID, 'ruflo': RUFLO_ID}
ADAPTER_ARGS = [m.NODE, m.ADAPTER]
RUFLO_ARGS = [m.NODE, m.RUFLO, 'mcp', 'start', '--transport', 'stdio']


def review_value(outcome='ACCEPT_FOCUSED_AUTH_API_EVIDENCE'):
    return {'schema': 'SD-FOCUSED-REVIEW-1', 'outcome': outcome,
            'sourceCommit': m.REVIEW_SOURCE, 'templateSha256': m.REVIEW_TEMPLATE,
            'evidenceCommit': m.REVIEW_EVIDENCE,
            'review': 'Synthetic independent source review with bounded HTTP evidence and preserved gates; private-sentinel is fixture text only.',
            'limitations': 'Local CLI fixture only; effective max remains UNPROVEN and this cannot prove a GUI extension session.'}


def events():
    rows = [{'type': 'system', 'subtype': 'init', 'session_id': SID, 'model': m.MODEL,
             'claude_code_version': '2.1.322', 'tools': [m.INBOX, m.SEND],
             'mcp_servers': [{'name': 'ruflo', 'status': 'connected'}]}]
    inbox = {'team': m.TEAM, 'agent': m.MEMBER, 'peek': True, 'messages': [{
        'teamId': m.TEAM, 'from': 'codex-lead', 'to': m.MEMBER,
        'content': json.dumps({'nonce': LINK['nonce'], 'expected_reply': LINK['expected_reply'], 'reply_to': 'codex-lead'})}]}
    args = [{'team': m.TEAM, 'agent': m.MEMBER, 'peek': True},
            {'team': m.TEAM, 'from': m.MEMBER, 'to': 'codex-lead', 'message': LINK['expected_reply']},
            {'team': m.TEAM, 'from': m.MEMBER, 'to': 'codex-lead',
             'message': json.dumps(review_value())}]
    for index, (name, data) in enumerate(zip([m.INBOX, m.SEND, m.SEND], args)):
        rows.append({'type': 'assistant', 'session_id': SID, 'message': {'model': m.MODEL, 'content': [{
            'type': 'tool_use', 'id': 'call-' + str(index), 'name': name, 'input': data}]}})
        value = inbox if index == 0 else {'success': True, 'action': 'send', 'recipients': ['codex-lead'],
            'message': {'teamId': m.TEAM, 'from': m.MEMBER, 'to': 'codex-lead', 'content': data['message']}}
        content = [{'type': 'text', 'text': json.dumps({'isError': False,
            'content': [{'type': 'text', 'text': json.dumps(value)}]})}]
        rows.append({'type': 'user', 'session_id': SID, 'message': {'content': [{
            'type': 'tool_result', 'tool_use_id': 'call-' + str(index), 'content': content}]}})
    rows.append({'type': 'result', 'subtype': 'success', 'session_id': SID, 'is_error': False,
                 'permission_denials': [], 'result': json.dumps(review_value()),
                 'modelUsage': {m.MODEL: {}}, 'num_turns': 4})
    return rows


class FakePorts:
    def __init__(self):
        self.calls = []
        self.saved = []
        self.failure = None
        self.auth_data = (0, {'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty',
                              'email': 'private-sentinel'})
        self.states = {row.pid: row for row in CAPTURED.values()}
        self.disappear_at_grace = True
        self.change_identity = False
        self.empty_group = True
        self.exit = 0
        self.event_rows = events()
        self.spawn_failure = False

    def admit(self, bundle):
        self.calls.append('admit')
        if bundle.get('tampered'):
            raise m.ReviewError('INPUT_REJECTED')

    def auth(self):
        self.calls.append('auth')
        return self.auth_data

    def reserve(self, bundle):
        self.calls.append('reserve')
        if bundle.get('collision'):
            raise m.ReviewError('CLAIM_COLLISION')

    def start(self, bundle):
        self.calls.append('start')
        if self.spawn_failure:
            raise RuntimeError('private-sentinel')
        return object()

    def collect(self, process, bundle, evidence, captured):
        self.calls.append('collect')
        captured.update(CAPTURED)
        if self.failure:
            raise self.failure
        for event in self.event_rows:
            evidence.accept(event)
        return captured, self.exit

    def revalidate(self, bundle):
        self.calls.append('revalidate')
        if bundle.get('drift_after_start') and 'start' in self.calls:
            raise m.ReviewError('SOURCE_DRIFT')

    def close_input(self, process):
        self.calls.append('close')

    def wait_grace(self, process, seconds):
        self.calls.append(('grace', seconds))
        if self.disappear_at_grace:
            self.states.clear()

    def identity(self, pid):
        if self.change_identity and pid == ADAPTER_ID.pid and pid in self.states:
            return m.Identity(pid, 999, 100, START, m.NODE)
        return self.states.get(pid)

    def signal_exact(self, process, name, identity, sig):
        self.calls.append(('signal', name, identity.pid, sig))
        self.states.pop(identity.pid, None)

    def group_empty(self, process):
        return self.empty_group and not self.states

    def save(self, report):
        self.saved.append(copy.deepcopy(report))


def bundle(**kwargs):
    return {'sessionId': SID, 'link': dict(LINK), **kwargs}


class FakeAuthProcess:
    pid = 230
    def __init__(self):
        self.returncode = None
        self.signals = []
        self.term_timeout = False
        self.poll_failure = False

    def poll(self):
        if self.poll_failure: raise RuntimeError('private-auth-poll')
        return self.returncode

    def wait(self, timeout):
        if self.returncode is None:
            raise subprocess.TimeoutExpired('fixed-owned-auth', timeout)
        return self.returncode

    def send_signal(self, sig):
        self.signals.append(int(sig))
        if not (sig == signal.SIGTERM and self.term_timeout): self.returncode = -int(sig)


class FakeAuthNative:
    def __init__(self, owner):
        self.owner = owner
        self.process = FakeAuthProcess()
        self.calls = []
        self.observation_error = False
        self.cleanup_query_error = False
        self.changed_identity = False
        self.bad_started = False
        self.capture_error = None
        self.raw = json.dumps({'loggedIn': False, 'authMethod': 'none', 'apiProvider': 'firstParty',
                               'email': 'private-account-sentinel'}).encode()
        self.exit = 1
        self.closed = False
        self.empty = True
        self.start_error = False

    def auth_start(self):
        self.calls.append('start')
        if self.start_error: raise RuntimeError('private-native-start')
        return self.process

    def identity(self, pid):
        self.calls.append('identity')
        if self.calls.count('identity') == 1:
            # The actual lifecycle must retain its handle before first query.
            assert self.owner.auth_process is self.process
            assert self.owner.auth_record['pid'] == pid
            if self.observation_error: raise RuntimeError('private-first-observation')
            return m.Identity(pid, 999 if self.changed_identity else os.getpid(), pid,
                              'private-start-sentinel' if self.bad_started else START, m.CLI)
        if self.cleanup_query_error: raise RuntimeError('private-cleanup-query')
        return None if self.process.returncode is not None else m.Identity(pid, os.getpid(), pid, START, m.CLI)

    def auth_capture(self, process):
        self.calls.append('capture')
        assert self.owner.auth_process is process
        if self.capture_error: raise self.capture_error
        process.returncode = self.exit
        return self.raw

    def group_empty(self, process):
        self.calls.append('group')
        return self.empty and process.returncode is not None

    def auth_close(self, process):
        self.calls.append('close')
        self.closed = True


class AuthLifecycleTests(unittest.TestCase):
    def fixture(self):
        owner = SimpleNamespace(auth_process=None, auth_record=None)
        return owner, FakeAuthNative(owner)

    def failed(self, owner, native, code='AUTH_UNRESOLVED'):
        with self.assertRaises(m.ReviewError) as caught: m.owned_auth_status(owner, native)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(owner.auth_record['firstFailure'], code)
        return owner.auth_record

    def test_real_auth_algorithm_retains_handle_before_first_observation(self):
        owner, native = self.fixture()
        exit_code, payload = m.owned_auth_status(owner, native)
        self.assertEqual(m.auth_projection(exit_code, payload)[0], 'AUTH_REQUIRED')
        self.assertTrue(owner.auth_record['cleanup']['safe'])
        self.assertEqual(owner.auth_record['pid'], 230)
        self.assertIs(owner.auth_process, native.process)
        self.assertTrue(native.closed)
        self.assertNotIn('private-account', json.dumps(owner.auth_record))

    def test_first_os_observation_failure_still_cleans_held_process(self):
        owner, native = self.fixture(); native.observation_error = True
        row = self.failed(owner, native)
        self.assertEqual(native.process.signals, [int(signal.SIGTERM)])
        self.assertTrue(row['cleanup']['pidAbsent']); self.assertTrue(native.closed)
        self.assertIsNone(row['identity']); self.assertIs(owner.auth_process, native.process)

    def test_changed_identity_never_adopts_other_process_but_retains_held_popen(self):
        owner, native = self.fixture(); native.changed_identity = True
        row = self.failed(owner, native)
        self.assertIsNone(row['identity'])
        self.assertEqual(native.process.signals, [int(signal.SIGTERM)])
        self.assertNotIn('capture', native.calls)

    def test_selector_construction_failure_is_inside_protected_lifecycle(self):
        owner, native = self.fixture(); native.capture_error = RuntimeError('private-selector-construction')
        row = self.failed(owner, native)
        self.assertEqual(native.process.signals, [int(signal.SIGTERM)])
        self.assertTrue(row['cleanup']['pidAbsent']); self.assertTrue(native.closed)

    def test_cleanup_query_failure_preserves_parse_primary_and_known_pid(self):
        owner, native = self.fixture(); native.raw = b'private-invalid-json'; native.cleanup_query_error = True
        row = self.failed(owner, native, 'AUTH_UNKNOWN')
        self.assertEqual(row['pid'], 230); self.assertIsNone(row['cleanup']['pidAbsent'])
        self.assertEqual(row['firstFailure'], 'AUTH_UNKNOWN'); self.assertTrue(native.closed)
        self.assertNotIn('private-', json.dumps(row))

    def test_unknown_cleanup_prevents_auth_unknown_status_from_masking_unresolved(self):
        ports = FakePorts(); native = FakeAuthNative(ports)
        native.raw = b'private-invalid-json'; native.cleanup_query_error = True
        ports.auth = lambda: m.owned_auth_status(ports, native)
        row = m.run_operator(bundle(), ports)
        self.assertEqual(row['status'], 'UNRESOLVED')
        self.assertEqual(row['firstFailure'], 'AUTH_UNKNOWN'); self.assertEqual(row['reviewStarts'], 0)

    def test_timeout_uses_bounded_held_term_then_kill_without_group_signal(self):
        owner, native = self.fixture(); native.capture_error = m.ReviewError('AUTH_UNRESOLVED')
        native.process.term_timeout = True
        row = self.failed(owner, native)
        self.assertEqual(native.process.signals, [int(signal.SIGTERM), int(signal.SIGKILL)])
        self.assertTrue(row['cleanup']['pidAbsent']); self.assertFalse(row['cleanup']['safe'])

    def test_poll_failure_never_masks_primary_or_discards_handle(self):
        owner, native = self.fixture(); native.raw = b'bad-json'; native.process.poll_failure = True
        row = self.failed(owner, native, 'AUTH_UNKNOWN')
        self.assertIs(owner.auth_process, native.process)
        self.assertEqual(native.process.signals, []); self.assertFalse(row['cleanup']['safe'])

    def test_private_or_malformed_start_metadata_is_not_public(self):
        owner, native = self.fixture(); native.bad_started = True
        row = self.failed(owner, native)
        self.assertIsNone(row['identity']); self.assertNotIn('private-start-sentinel', json.dumps(row))

    def test_uncertain_native_start_keeps_requested_not_safe_zero(self):
        owner, native = self.fixture(); native.start_error = True
        row = self.failed(owner, native)
        self.assertTrue(row['requested']); self.assertTrue(row['startUnconfirmed'])
        self.assertFalse(row['started']); self.assertIsNone(owner.auth_process)


class LiveSourceTests(unittest.TestCase):
    def setUp(self):
        self.data = {'/synthetic/source': b'frozen source', '/synthetic/proof': b'frozen proof'}
        self.item = {'candidate': {'cwd': '/synthetic/checkout', 'sourceCommit': 'a' * 40},
                     'payload': json.dumps({'files': [{'kind': 'SOURCE', 'path': key,
                         'sha256': m.digest(value)} for key, value in self.data.items()]
                         + [{'kind': 'DESCRIPTOR_SUMMARY', 'path': 'not-a-file', 'sha256': 'unused'}]}).encode()}
        self.dirty = False
        self.head = 'a' * 40
        self.reads = []

    def read(self, path, **options):
        self.reads.append(path)
        if path not in self.data:
            raise AssertionError('REAL_STATE_PORT_DISABLED')
        return self.data[path]

    def command(self, args, cwd):
        self.assertEqual(cwd, Path('/synthetic/checkout'))
        self.assertEqual(args[:5], ['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
                                   'rev-parse' if args[-1] == 'HEAD' else 'status'])
        return self.head.encode() + b'\n' if args[-1] == 'HEAD' else (b' M file\n' if self.dirty else b'')

    def test_exact_live_sources_repeat_on_each_phase(self):
        for _ in range(3): m.validate_live_sources(self.item, self.read, self.command)
        self.assertEqual(self.reads, list(self.data) * 3)

    def test_post_admission_source_change_rejected(self):
        m.validate_live_sources(self.item, self.read, self.command)
        self.data['/synthetic/source'] = b'changed after auth'
        with self.assertRaises(m.ReviewError) as caught:
            m.validate_live_sources(self.item, self.read, self.command)
        self.assertEqual(caught.exception.code, 'SOURCE_DRIFT')

    def test_post_admission_head_or_worktree_change_rejected(self):
        for head, dirty in [('b' * 40, False), ('a' * 40, True)]:
            self.head, self.dirty = head, dirty
            with self.assertRaises(m.ReviewError):
                m.validate_live_sources(self.item, self.read, self.command)

    def test_missing_read_or_metadata_port_cannot_fall_through(self):
        with self.assertRaises(m.ReviewError): m.validate_live_sources(self.item, None, self.command)


class SelectionTests(unittest.TestCase):
    def rows(self):
        return [{'identity': ADAPTER_ID, 'argumentDisplay': ' '.join(ADAPTER_ARGS)},
                {'identity': RUFLO_ID, 'argumentDisplay': ' '.join(RUFLO_ARGS)}]

    def test_exact_chain_and_cli_held_argv_not_joined_display(self):
        found = m.select_chain(CLI_ID, 100, 10, self.rows(), ADAPTER_ARGS, RUFLO_ARGS)
        self.assertEqual(found, CAPTURED)
        self.assertNotIn('', ADAPTER_ARGS)
        self.assertNotIn('', RUFLO_ARGS)

    def test_partial_chain_is_observation_not_success(self):
        partial = m.select_chain(CLI_ID, 100, 10, [], ADAPTER_ARGS, RUFLO_ARGS)
        self.assertIsNone(partial['adapter'])
        self.assertIsNone(partial['ruflo'])

    def test_unknown_host_managed_parent_denied(self):
        cli = m.Identity(100, 999, 100, START, m.CLI)
        with self.assertRaises(m.ReviewError):
            m.select_chain(cli, 100, 10, self.rows(), ADAPTER_ARGS, RUFLO_ARGS)

    def test_unknown_child(self):
        rows = self.rows() + [{'identity': m.Identity(105, 102, 100, START, m.NODE), 'argumentDisplay': 'private-sentinel'}]
        with self.assertRaises(m.ReviewError):
            m.select_chain(CLI_ID, 100, 10, rows, ADAPTER_ARGS, RUFLO_ARGS)

    def test_child_argv_mutation_denied(self):
        rows = self.rows(); rows[1]['argumentDisplay'] += ' --unexpected'
        with self.assertRaises(m.ReviewError):
            m.select_chain(CLI_ID, 100, 10, rows, ADAPTER_ARGS, RUFLO_ARGS)

    def test_detached_child_denied(self):
        rows = self.rows(); rows[0]['identity'] = m.Identity(101, 100, 999, START, m.NODE)
        with self.assertRaises(m.ReviewError):
            m.select_chain(CLI_ID, 100, 10, rows, ADAPTER_ARGS, RUFLO_ARGS)

    def test_old_birth_denied(self):
        rows = self.rows(); rows[0]['identity'] = m.Identity(101, 100, 100, 'Tue Nov 10 01:50:00 2026', m.NODE)
        with self.assertRaises(m.ReviewError):
            m.select_chain(CLI_ID, 100, 10, rows, ADAPTER_ARGS, RUFLO_ARGS)

    def test_ambiguous_adapter_denied(self):
        rows = self.rows() + [{'identity': m.Identity(106, 100, 100, START, m.NODE), 'argumentDisplay': ' '.join(ADAPTER_ARGS)}]
        with self.assertRaises(m.ReviewError):
            m.select_chain(CLI_ID, 100, 10, rows, ADAPTER_ARGS, RUFLO_ARGS)


class EvidenceTests(unittest.TestCase):
    def check_reject(self, action):
        rows = events(); action(rows)
        evidence = m.StreamEvidence(SID, LINK)
        with self.assertRaises(m.ReviewError):
            for row in rows:
                evidence.accept(row)
            evidence.summary()

    def test_fake_supported_shape_correlated_three_calls_but_effort_never_self_certifies(self):
        e = m.StreamEvidence(SID, LINK)
        for row in events(): e.accept(row)
        result = e.summary()
        self.assertEqual(result['mailboxCalls'], 3)
        self.assertEqual(result['effectiveEffort'], 'UNPROVEN')
        self.assertFalse(result['actualClaudeExtensionACK'])
        self.assertNotIn('private-sentinel', json.dumps(result))

    def test_wrong_model(self): self.check_reject(lambda rows: rows[1]['message'].update(model='claude-other'))
    def test_wrong_session(self): self.check_reject(lambda rows: rows[2].update(session_id='other'))
    def test_unlisted_tool(self): self.check_reject(lambda rows: rows[1]['message']['content'][0].update(name='mcp__ruflo__team_spawn'))
    def test_unknown_builtin(self): self.check_reject(lambda rows: rows[0]['tools'].append('Bash'))
    def test_other_mcp(self): self.check_reject(lambda rows: rows[0]['mcp_servers'].append({'name': 'other'}))
    def test_max_turns(self): self.check_reject(lambda rows: rows[-1].update(num_turns=9))
    def test_fallback_result(self): self.check_reject(lambda rows: rows[-1].update(modelUsage={'fallback': {}}))
    def test_missing_substantive_review(self): self.check_reject(lambda rows: rows[-1].update(result=''))
    def test_wrong_correlation(self): self.check_reject(lambda rows: rows[2]['message']['content'][0].update(tool_use_id='other'))
    def test_ack_before_inbox_result(self): self.check_reject(lambda rows: rows.__delitem__(2))
    def test_sender_impersonation(self): self.check_reject(lambda rows: rows[3]['message']['content'][0]['input'].update({'from': 'codex-lead'}))
    def test_nonce_mismatch(self): self.check_reject(lambda rows: rows[3]['message']['content'][0]['input'].update(message='wrong-ack'))
    def test_tool_denial(self): self.check_reject(lambda rows: rows[4]['message']['content'][0].update(is_error=True))
    def test_result_denial(self): self.check_reject(lambda rows: rows[-1].update(permission_denials=[{'tool': 'private-sentinel'}]))
    def test_unknown_policy_event(self): self.check_reject(lambda rows: rows.insert(1, {'type': 'system', 'subtype': 'hook_started', 'session_id': SID}))
    def test_fourth_call(self): self.check_reject(lambda rows: rows.insert(-1, copy.deepcopy(rows[1])))

    def test_frames_fragmentation(self):
        e = m.StreamEvidence(SID, LINK); parser = m.Frames(e)
        data = b''.join(json.dumps(row).encode() + b'\n' for row in events())
        for start in range(0, len(data), 17): parser.feed(data[start:start + 17])
        parser.finish(); self.assertEqual(e.summary()['mailboxCalls'], 3)

    def test_frames_malformed_and_incomplete(self):
        for data, finish in [(b'{private-sentinel}\n', False), (b'{', True)]:
            p = m.Frames(m.StreamEvidence(SID, LINK))
            with self.assertRaises(m.ReviewError):
                p.feed(data)
                if finish: p.finish()

    def test_frame_limit(self):
        with self.assertRaises(m.ReviewError):
            m.Frames(m.StreamEvidence(SID, LINK)).feed(b'x' * (m.MAX_FRAME + 1))

    def test_stdout_limit(self):
        with self.assertRaises(m.ReviewError):
            m.Frames(m.StreamEvidence(SID, LINK)).feed(b'x' * (m.MAX_STDOUT + 1))


class DeclarationTests(unittest.TestCase):
    def send_rows(self, value):
        text = value if isinstance(value, str) else json.dumps(value)
        rows = events()
        rows[5]['message']['content'][0]['input']['message'] = text
        data = {'success': True, 'action': 'send', 'recipients': ['codex-lead'],
                'message': {'teamId': m.TEAM, 'from': m.MEMBER, 'to': 'codex-lead', 'content': text}}
        rows[6]['message']['content'][0]['content'] = [{'type': 'text', 'text': json.dumps(data)}]
        rows[-1]['result'] = text
        return rows

    def reject(self, value):
        evidence = m.StreamEvidence(SID, LINK)
        with self.assertRaises(m.ReviewError) as caught:
            for row in self.send_rows(value): evidence.accept(row)
            evidence.summary()
        self.assertEqual(caught.exception.code, 'REVIEW_DECLARATION_REJECTED')

    def test_nonblank_nonce_suffix_and_one_byte_review_are_rejected(self):
        for value in ['', ' ', '.', 'x', LINK['expected_reply'], LINK['expected_reply'] + '\n']:
            self.reject(value)

    def test_empty_trivial_unclassified_and_missing_context_are_rejected(self):
        for field, value in [('review', '.'), ('review', ' ' * 90), ('limitations', ''), ('outcome', 'PASS')]:
            item = review_value(); item[field] = value; self.reject(item)
        for field in ['sourceCommit', 'templateSha256', 'evidenceCommit', 'outcome']:
            item = review_value(); del item[field]; self.reject(item)

    def test_wrong_source_template_or_evidence_are_rejected(self):
        for field in ['sourceCommit', 'templateSha256', 'evidenceCommit']:
            item = review_value(); item[field] = '0' * len(item[field]); self.reject(item)

    def test_extra_or_duplicate_declaration_fields_are_rejected(self):
        item = review_value(); item['extra'] = 'private-sentinel'; self.reject(item)
        raw = json.dumps(review_value())
        self.reject(raw[:-1] + ',"outcome":"REQUEST_CHANGES"}')

    def test_substantive_request_changes_preserves_declared_outcome_without_acceptance(self):
        evidence = m.StreamEvidence(SID, LINK)
        for row in self.send_rows(review_value('REQUEST_CHANGES')): evidence.accept(row)
        self.assertEqual(evidence.summary()['reviewOutcome'], 'REQUEST_CHANGES')
        self.assertEqual(evidence.summary()['effectiveEffort'], 'UNPROVEN')

    def test_final_result_must_match_the_acknowledged_declared_review(self):
        rows = self.send_rows(review_value())
        item = review_value(); item['outcome'] = 'REQUEST_CHANGES'; rows[-1]['result'] = json.dumps(item)
        evidence = m.StreamEvidence(SID, LINK)
        with self.assertRaises(m.ReviewError) as caught:
            for row in rows: evidence.accept(row)
        self.assertEqual(caught.exception.code, 'REVIEW_RESULT_MISMATCH')

    def test_incomplete_outcome_never_increments_completed_review(self):
        ports = FakePorts(); ports.event_rows = self.send_rows(review_value('REVIEW_INCOMPLETE'))
        report = m.run_operator(bundle(), ports)
        self.assertEqual(report['status'], 'REVIEW_INCOMPLETE')
        self.assertEqual(report['reviewCompleted'], 0)
        self.assertEqual(report['evidence']['reviewOutcome'], 'REVIEW_INCOMPLETE')
        self.assertNotIn('private-sentinel', json.dumps(report))


class LocalEffortProvenanceTests(unittest.TestCase):
    def test_missing_and_null_vendor_effort_remain_unproven(self):
        for explicit_null in [False, True]:
            rows = events()
            if explicit_null: rows[0]['effort'] = None
            evidence = m.StreamEvidence(SID, LINK)
            for row in rows: evidence.accept(row)
            self.assertEqual(evidence.summary()['effectiveEffort'], 'UNPROVEN')

    def test_nonnull_effort_is_unsupported_on_local_print_even_claimed_max(self):
        for value in ['max', 'xhigh', 'high', 'medium', 'low', 'unknown', True, 8, {'effort': 'max'}]:
            evidence = m.StreamEvidence(SID, LINK)
            first = events()[0]; first['effort'] = value
            with self.assertRaises(m.ReviewError) as caught: evidence.accept(first)
            self.assertEqual(caught.exception.code, 'CLIENT_INIT_UNSUPPORTED')
            self.assertFalse(evidence.initialized)

    def test_assistant_text_and_result_effort_never_certify_requested_mode(self):
        rows = events()
        rows[1]['message']['content'].insert(0, {'type': 'text', 'text': '{"effort":"max","effectiveEffort":"max"}'})
        rows[-1]['effort'] = 'max'
        evidence = m.StreamEvidence(SID, LINK)
        for row in rows: evidence.accept(row)
        result = evidence.summary()
        self.assertEqual(result['requestedEffort'], 'max')
        self.assertEqual(result['effectiveEffort'], 'UNPROVEN')
        self.assertFalse(result['actualClaudeExtensionACK'])

    def test_wrong_session_model_and_duplicate_init_cannot_supply_effort(self):
        for field, value in [('session_id', 'forged-session'), ('model', 'claude-other')]:
            evidence = m.StreamEvidence(SID, LINK); first = events()[0]; first[field] = value
            with self.assertRaises(m.ReviewError): evidence.accept(first)
        evidence = m.StreamEvidence(SID, LINK); evidence.accept(events()[0])
        duplicate = events()[0]; duplicate['effort'] = 'max'
        with self.assertRaises(m.ReviewError): evidence.accept(duplicate)

    def test_unsupported_effort_never_completes_review_even_after_safe_cleanup(self):
        ports = FakePorts(); ports.event_rows[0]['effort'] = 'max'
        result = m.run_operator(bundle(), ports)
        self.assertEqual(result['firstFailure'], 'CLIENT_INIT_UNSUPPORTED')
        self.assertEqual(result['reviewCompleted'], 0)
        self.assertTrue(result['cleanup']['safe'])
        self.assertEqual(result['effectiveEffort'], 'UNPROVEN')

    def test_unsupported_effort_preserves_primary_when_cleanup_unknown(self):
        ports = FakePorts(); ports.event_rows[0]['effort'] = 'xhigh'; ports.empty_group = False
        result = m.run_operator(bundle(), ports)
        self.assertEqual(result['status'], 'UNRESOLVED')
        self.assertEqual(result['firstFailure'], 'CLIENT_INIT_UNSUPPORTED')
        self.assertEqual(result['reviewCompleted'], 0)


class LifecycleTests(unittest.TestCase):
    def test_valid_fake_review_is_effort_unproven_not_pass(self):
        p = FakePorts(); report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'REVIEW_RECEIVED_EFFORT_UNPROVEN')
        self.assertEqual(report['reviewStarts'], 1)
        self.assertEqual(report['reviewCompleted'], 1)
        self.assertTrue(report['cleanup']['safe'])
        self.assertEqual(report['cleanup']['signals'], [])
        self.assertIn(('grace', 9), p.calls)
        self.assertNotIn('private-sentinel', json.dumps(report))

    def test_auth_false_one_metadata_zero_review_no_claim(self):
        p = FakePorts(); p.auth_data = (1, {'loggedIn': False, 'authMethod': 'none', 'apiProvider': 'firstParty', 'email': 'private-sentinel'})
        report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'AUTH_REQUIRED')
        self.assertEqual((report['authChecks'], report['reviewStarts']), (1, 0))
        self.assertNotIn('reserve', p.calls)
        self.assertNotIn('private-sentinel', json.dumps(report))

    def test_bad_auth_never_launches(self):
        for value in [None, {}, {'loggedIn': 0, 'authMethod': 'none', 'apiProvider': 'firstParty'},
                      {'loggedIn': True, 'authMethod': 'api_key', 'apiProvider': 'firstParty'}]:
            p = FakePorts(); p.auth_data = (0, value)
            report = m.run_operator(bundle(), p)
            self.assertEqual(report['firstFailure'], 'AUTH_UNKNOWN'); self.assertNotIn('start', p.calls)

    def test_source_tamper_precedes_auth(self):
        p = FakePorts(); report = m.run_operator(bundle(tampered=True), p)
        self.assertEqual(report['firstFailure'], 'INPUT_REJECTED'); self.assertNotIn('auth', p.calls)

    def test_exclusive_claim_collision_never_starts(self):
        p = FakePorts(); report = m.run_operator(bundle(collision=True), p)
        self.assertEqual(report['firstFailure'], 'CLAIM_COLLISION'); self.assertNotIn('start', p.calls)

    def test_spawn_uncertainty_never_claims_safe_zero(self):
        p = FakePorts(); p.spawn_failure = True; report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertTrue(report['reviewStartUnconfirmed'])

    def test_first_failure_retained_through_cleanup(self):
        p = FakePorts(); p.failure = m.ReviewError('TIMEOUT'); p.disappear_at_grace = False; p.change_identity = True
        report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertEqual(report['firstFailure'], 'TIMEOUT')
        self.assertFalse(any(isinstance(c, tuple) and c[:2] == ('signal', 'adapter') for c in p.calls))

    def test_unknown_child_never_signals(self):
        p = FakePorts(); p.failure = m.ReviewError('UNKNOWN_CHILD'); p.disappear_at_grace = False
        report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertEqual(report['cleanup']['signals'], [])

    def test_unknown_child_stays_unresolved_even_after_absence(self):
        p = FakePorts(); p.failure = m.ReviewError('UNKNOWN_CHILD')
        report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertTrue(report['cleanup']['safe'])

    def test_unresolved_metadata_preflight_never_claims_known_absence(self):
        p = FakePorts()
        def failed_auth(): raise m.ReviewError('AUTH_UNRESOLVED')
        p.auth = failed_auth
        report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertEqual(report['reviewStarts'], 0)

    def test_evidence_write_failure_retains_primary(self):
        p = FakePorts(); p.failure = m.ReviewError('TIMEOUT')
        def broken_save(report): raise RuntimeError('private-sentinel')
        p.save = broken_save
        report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertEqual(report['firstFailure'], 'TIMEOUT')
        self.assertNotIn('private-sentinel', json.dumps(report))

    def test_forced_cleanup_never_success(self):
        p = FakePorts(); p.disappear_at_grace = False; report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED'); self.assertTrue(report['cleanup']['forced'])

    def test_parent_absence_is_not_child_absence(self):
        p = FakePorts(); p.failure = m.ReviewError('UNKNOWN_CHILD'); p.disappear_at_grace = False; p.states.pop(100)
        report = m.run_operator(bundle(), p)
        self.assertTrue(report['cleanup']['absent']['cli']); self.assertFalse(report['cleanup']['absent']['adapter'])

    def test_missing_group_absence_blocks(self):
        p = FakePorts(); p.empty_group = False; report = m.run_operator(bundle(), p)
        self.assertEqual(report['status'], 'UNRESOLVED')

    def test_input_pin_revalidation_after_review(self):
        p = FakePorts(); report = m.run_operator(bundle(drift_after_start=True), p)
        self.assertEqual(report['firstFailure'], 'SOURCE_DRIFT')
        self.assertEqual(report['status'], 'FAILED_REVIEW_REQUIRED')

    def test_private_failure_never_public(self):
        p = FakePorts(); p.failure = m.ReviewError('private-sentinel'); report = m.run_operator(bundle(), p)
        self.assertNotIn('private-sentinel', json.dumps(report)); self.assertEqual(report['firstFailure'], 'UNEXPECTED_OPERATOR_ERROR')

    def test_missing_fake_port_has_no_real_fallback(self):
        with self.assertRaises(m.ReviewError): m.run_operator(bundle(), object())


class AdmissionTests(unittest.TestCase):
    def proof(self):
        return {'schema': 'SD-CLAUDE-STARTUP-PROOF-1', 'clientSha256': 'client',
            'candidateSha256': m.CANDIDATE_SHA, 'authoritative': True, 'flagsVerified': True,
            'restrictedExcludesUserProjectLocal': True, 'managedPolicyPreserved': True,
            **{k: 0 for k in ['managedCommandHooks', 'managedStatusLineCommands', 'managedPlugins',
                'managedCredentialHelpers', 'providerOverrides', 'unreviewedMcpServers', 'dynamicWorkflows']},
            'streamSchema': 'CLAUDE_2_1_322_DOCUMENTED_INIT_MESSAGE_TOOL_RESULT',
            'supportedEvidenceSha256': 'a' * 64,
            'publicProfileSha256': 'da259bf7c092b85ec3966dccf400d5053ffc33d82ec3e6c453a3ef3c39b48fc4',
            'preservationSha256': 'b' * 64}

    def test_startup_data_is_prerequisite_not_live_proof(self):
        m.validate_startup(self.proof(), {'executableSha256': 'client'})
        for field, value in [('authoritative', False), ('flagsVerified', False), ('managedCommandHooks', 1),
                             ('managedPolicyPreserved', False), ('unreviewedMcpServers', 1), ('streamSchema', 'UNKNOWN')]:
            bad = self.proof(); bad[field] = value
            with self.assertRaises(m.ReviewError): m.validate_startup(bad, {'executableSha256': 'client'})

    def test_unknown_startup_fields_deny(self):
        bad = self.proof(); bad['private-sentinel'] = True
        with self.assertRaises(m.ReviewError): m.validate_startup(bad, {'executableSha256': 'client'})

    def test_receipt_requires_exact_two_nonauthors(self):
        expected = {'source': 'frozen'}
        good = {**expected, 'reviewers': [{'agent': agent, 'decision': 'APPROVE_ONE_OWNED_CLAUDE_REVIEW'} for agent in sorted(m.REVIEWERS)]}
        m.validate_receipt(good, expected)
        for reviewers in [good['reviewers'][:1], good['reviewers'] * 2,
                          [{'agent': m.AUTHOR, 'decision': 'APPROVE_ONE_OWNED_CLAUDE_REVIEW'}, good['reviewers'][0]]]:
            with self.assertRaises(m.ReviewError): m.validate_receipt({**expected, 'reviewers': reviewers}, expected)

    def test_regular_input_denies_symlink_hardlink_private_mode_and_limit(self):
        global allowed_test_root
        with tempfile.TemporaryDirectory() as temp:
            allowed_test_root = Path(temp)
            file = allowed_test_root / 'input'; file.write_bytes(b'synthetic'); file.chmod(0o600)
            self.assertEqual(m.regular(file, private=True), b'synthetic')
            symlink = allowed_test_root / 'symlink'; symlink.symlink_to(file)
            with self.assertRaises(m.ReviewError): m.regular(symlink)
            linked = allowed_test_root / 'linked'; os.link(file, linked)
            with self.assertRaises(m.ReviewError): m.regular(file)
            linked.unlink(); file.chmod(0o644)
            with self.assertRaises(m.ReviewError): m.regular(file, private=True)
            with self.assertRaises(m.ReviewError): m.regular(file, limit=1)
        allowed_test_root = None

    def test_real_effect_ports_are_globally_disabled(self):
        for action in [lambda: subprocess.Popen(['false']), lambda: socket.socket(),
                       lambda: os.kill(1, 0), lambda: m.RealPorts().auth(), lambda: m.load_fixed(),
                       lambda: m.regular('/Users/shubham/.claude.json')]:
            with self.assertRaises(AssertionError): action()


class FixedInputTests(unittest.TestCase):
    """Exercise the real loader with a closed in-memory reader, never host state."""
    def setUp(self):
        self.previous = m.CANDIDATE_SHA, m.MANIFEST_SHA, m.PINNED_FILES
        self.data = {}
        self.reads = []
        encode = lambda value: json.dumps(value, sort_keys=True).encode()
        self.data[m.CLI] = b'synthetic-native-client'
        self.data[m.NODE] = b'synthetic-node'
        m.PINNED_FILES = {key: m.digest(value) for key, value in self.data.items()}
        link = {**LINK, 'actual_claude_extension_acknowledged': False,
                'team': m.TEAM, 'claude_agent': m.MEMBER}
        self.link_path = '/synthetic-owned/link.json'
        link_bytes = encode(link)
        files = [{'kind': 'FROZEN_SOURCE', 'path': '/synthetic/' + str(i),
                  'sha256': m.digest(b'inert source'), 'content': 'inert source'} for i in range(m.SNAPSHOT_FILE_COUNT - 1)]
        files.append({'kind': 'SAFE_PENDING_LINK_METADATA', 'path': self.link_path,
                      'sha256': m.digest(link_bytes), 'content': link_bytes.decode()})
        prompt = b'synthetic instructions, not a model request'
        self.payload_path = '/synthetic-owned/review-input.json'
        payload = encode({'instruction': prompt.decode(), 'files': files})
        config = b'{"mcpServers":{"ruflo":{"type":"stdio"}}}'
        manifest = {'privateInput': self.payload_path, 'inputSha256': m.digest(payload),
                    'mcpConfigSha256': m.digest(config), 'promptSha256': m.digest(prompt),
                    'sourceCommit': m.REVIEW_SOURCE, 'evidenceCommit': m.REVIEW_EVIDENCE,
                    'descriptorSha256': m.REVIEW_TEMPLATE, 'fileCount': m.SNAPSHOT_FILE_COUNT,
                    'files': [{k: v for k, v in f.items() if k != 'content'} for f in files]}
        manifest_bytes = encode(manifest)
        m.MANIFEST_SHA = m.digest(manifest_bytes)
        candidate = {'environment': m.ENVIRONMENT, 'executable': m.CLI,
            'executableSha256': m.PINNED_FILES[m.CLI], 'stdinFile': self.payload_path,
            'stdinSha256': m.digest(payload), 'stdinBytes': len(payload),
            'inputManifestSha256': m.MANIFEST_SHA, 'mcpConfigSha256': m.digest(config),
            'sessionId': SID, 'argv': ['--print', '--model', m.MODEL, '--effort', 'max', '--tools', '', '--session-id', SID],
            'sourceCommit': m.REVIEW_SOURCE, 'evidenceCommit': m.REVIEW_EVIDENCE,
            'timeoutSeconds': m.REVIEW_SECONDS, 'maxTurns': m.MAX_TURNS,
            'privateOutputDirectory': '/synthetic-owned/output'}
        candidate_bytes = encode(candidate)
        m.CANDIDATE_SHA = m.digest(candidate_bytes)
        proof = AdmissionTests().proof(); proof['clientSha256'] = candidate['executableSha256']
        proof_bytes = encode(proof)
        helper = b'synthetic-operator-source'
        receipt = {'schema': 'SD-CLAUDE-REVIEW-APPROVAL-1', 'decision': 'APPROVE_ONE_OWNED_CLAUDE_REVIEW',
            'operatorSha256': m.digest(helper), 'testsSha256': m.digest(b'synthetic-fake-tests'),
            'contractSha256': '97dc92ae0469a346eb2094833cc4c697b4c7ad105a753dc086a52289544895a9',
            'amendmentSha256': m.AMENDMENT_SHA,
            'candidateSha256': m.CANDIDATE_SHA,
            'inputManifestSha256': m.MANIFEST_SHA, 'stdinSha256': candidate['stdinSha256'],
            'startupProofSha256': m.digest(proof_bytes), 'sourceCommit': candidate['sourceCommit'],
            'evidenceCommit': candidate['evidenceCommit'], 'sessionId': SID,
            'outputDirectory': candidate['privateOutputDirectory'], 'outputDevice': 111, 'outputInode': 222,
            'reviewers': [{'agent': name, 'decision': 'APPROVE_ONE_OWNED_CLAUDE_REVIEW'} for name in sorted(m.REVIEWERS)]}
        self.data.update({str(m.QA / 'claude-review-invocation.json'): candidate_bytes,
            str(m.QA / 'claude-review-input-manifest.json'): manifest_bytes,
            str(m.QA / 'claude-review-mcp.json'): config,
            str(m.QA / 'CLAUDE_CLI_REVIEW_PROMPT.md'): prompt,
            self.payload_path: payload, self.link_path: link_bytes,
            str(m.PROOF_PATH): proof_bytes, str(m.APPROVAL_PATH): encode(receipt),
            m.__file__: helper, str(Path(m.__file__).with_name('claude-ruflo-review.test.py')): b'synthetic-fake-tests'})

    def tearDown(self):
        m.CANDIDATE_SHA, m.MANIFEST_SHA, m.PINNED_FILES = self.previous

    def reader(self, path, **options):
        self.reads.append((str(path), options))
        if str(path) not in self.data:
            raise AssertionError('REAL_STATE_PORT_DISABLED')
        return self.data[str(path)]

    def load(self, proof_exists=True):
        return original_load_fixed(reader=self.reader, proof_exists=lambda: proof_exists,
                                   directory_reader=lambda path: (111, 222))

    def test_all_fixed_input_checks_accept_closed_fake_data(self):
        value = self.load()
        self.assertEqual(value['sessionId'], SID)
        self.assertEqual(value['payload'], self.data[self.payload_path])

    def test_partial_fake_reader_has_no_real_exists_fallback(self):
        with self.assertRaises(m.ReviewError): original_load_fixed(reader=self.reader)

    def test_candidate_flags_tamper_before_metadata(self):
        path = str(m.QA / 'claude-review-invocation.json')
        value = json.loads(self.data[path]); value['argv'].append('--dangerously-skip-permissions')
        self.data[path] = json.dumps(value).encode()
        with self.assertRaises(m.ReviewError): self.load()
        self.assertNotIn(str(m.PROOF_PATH), [p for p, _ in self.reads])

    def test_rehashed_stale_window_and_target_fail_before_startup_metadata(self):
        path = str(m.QA / 'claude-review-invocation.json')
        initial = self.data[path]
        for field, value in [('timeoutSeconds', 1200), ('timeoutSeconds', 0),
                             ('maxTurns', 32), ('sourceCommit', 'a' * 40),
                             ('evidenceCommit', 'b' * 40)]:
            item = json.loads(initial); item[field] = value
            changed = json.dumps(item).encode()
            self.data[path] = changed; m.CANDIDATE_SHA = m.digest(changed); self.reads.clear()
            with self.assertRaises(m.ReviewError): self.load()
            self.assertNotIn(str(m.PROOF_PATH), [p for p, _ in self.reads])

    def test_manifest_tamper(self):
        self.data[str(m.QA / 'claude-review-input-manifest.json')] += b' '
        with self.assertRaises(m.ReviewError): self.load()

    def test_pinned_binary_tamper(self):
        self.data[m.NODE] = b'changed binary'
        with self.assertRaises(m.ReviewError): self.load()

    def test_payload_tamper(self):
        self.data[self.payload_path] += b' '
        with self.assertRaises(m.ReviewError): self.load()

    def test_mcp_config_tamper(self):
        self.data[str(m.QA / 'claude-review-mcp.json')] += b' '
        with self.assertRaises(m.ReviewError): self.load()

    def test_live_link_tamper(self):
        self.data[self.link_path] = b'{"nonce":"foreign"}'
        with self.assertRaises(m.ReviewError): self.load()

    def test_missing_authoritative_metadata_blocks(self):
        with self.assertRaises(m.ReviewError) as caught: self.load(False)
        self.assertEqual(caught.exception.code, 'PREFLIGHT_BLOCKED')

    def test_startup_proof_changed_or_forged(self):
        proof = json.loads(self.data[str(m.PROOF_PATH)]); proof['managedCommandHooks'] = 1
        self.data[str(m.PROOF_PATH)] = json.dumps(proof).encode()
        with self.assertRaises(m.ReviewError): self.load()

    def test_operator_source_drift_invalidates_exact_receipt(self):
        self.data[m.__file__] = b'changed source'
        with self.assertRaises(m.ReviewError): self.load()

    def test_receipt_extra_field_rejected(self):
        path = str(m.APPROVAL_PATH); value = json.loads(self.data[path]); value['extra'] = 'private-sentinel'
        self.data[path] = json.dumps(value).encode()
        with self.assertRaises(m.ReviewError): self.load()

    def test_receipt_session_forgery_rejected(self):
        path = str(m.APPROVAL_PATH); value = json.loads(self.data[path]); value['sessionId'] = 'wrong-session'
        self.data[path] = json.dumps(value).encode()
        with self.assertRaises(m.ReviewError): self.load()

    def test_output_directory_replacement_invalidates_receipt(self):
        with self.assertRaises(m.ReviewError):
            original_load_fixed(reader=self.reader, proof_exists=lambda: True,
                                directory_reader=lambda path: (111, 333))


class ReviewWindowTests(unittest.TestCase):
    def test_real_collection_clock_survives_old_deadline_and_stops_at_new_bound(self):
        class Pipe:
            def fileno(self): return 88
        class Selector:
            def __init__(self): self.closed = False
            def register(self, *args): pass
            def get_map(self): return {'active': None}
            def select(self, timeout): return []
            def close(self): self.closed = True
        class Collector:
            def __init__(self): self.observations = 0
            def observe(self, process, captured): self.observations += 1
        ports = Collector()
        process = SimpleNamespace(stdin=Pipe(), stdout=Pipe(), stderr=Pipe(), poll=lambda: None)
        selector = Selector(); clock = iter([0, 1201, 3599, 3600])
        previous = m.time.monotonic, m.selectors.DefaultSelector, m.os.set_blocking
        try:
            m.time.monotonic = lambda: next(clock)
            m.selectors.DefaultSelector = lambda: selector
            m.os.set_blocking = lambda *args: None
            with self.assertRaises(m.ReviewError) as caught:
                original_collect(ports, process, {'payload': b'inert'}, m.StreamEvidence(SID, LINK), dict(CAPTURED))
            self.assertEqual(caught.exception.code, 'TIMEOUT')
            self.assertEqual(ports.observations, 3)
            self.assertTrue(selector.closed)
        finally:
            m.time.monotonic, m.selectors.DefaultSelector, m.os.set_blocking = previous

    def test_only_wall_clock_limit_changes_no_cleanup_or_tool_budget_increase(self):
        self.assertEqual(m.REVIEW_SECONDS, 3600)
        self.assertEqual(m.MAX_TURNS, 8)
        self.assertEqual(m.EOF_SECONDS, 9)
        self.assertEqual(m.MAX_STDOUT, 8 * 1024 * 1024)
        self.assertEqual(m.MAX_STDERR, 64 * 1024)


if __name__ == '__main__':
    if not sys.flags.isolated or len(sys.argv) != 1:
        raise SystemExit('FIXED_ISOLATED_FAKE_UNIT_ENTRY_REQUIRED')
    unittest.main(verbosity=2)

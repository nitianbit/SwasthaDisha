"""One fixed local model review; private capture, explicit ports, no fallback.

No application imports. Live invocation needs its separate exact receipt and
supported client/managed-policy admission; offline tests have no real ports.
"""
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid


AUTHOR = '/root/claude_review_window'
REVIEWERS = {'/root', '/root/backend_boot_path'}
MODEL = 'claude-opus-5-5'
REVIEW_SOURCE = 'c2dbac3e44b0bbf30e4574640cd940e2f0075975'
REVIEW_TEMPLATE = '185fb708ef0af3b4bbf106b836baee69d20b922a6089b418e42ed739f6e801e7'
REVIEW_EVIDENCE = '638f44dea50fca667e4cf2accfb2f6c82b5e9cd5'
AMENDMENT_SHA = '5b67a3e5582d094cd2579850e1060673f999a539574f5323dd7842ef5a1c5ddd'
TEAM = 'swasthadisha-local'
MEMBER = 'claude-reviewer'
INBOX = 'mcp__ruflo__team_inbox'
SEND = 'mcp__ruflo__team_send'
MAX_STDOUT = 8 * 1024 * 1024
MAX_STDERR = 64 * 1024
MAX_FRAME = 2 * 1024 * 1024
REVIEW_SECONDS = 3600
MAX_TURNS = 8
SNAPSHOT_FILE_COUNT = 141
EOF_SECONDS = 9
CLI = '/Users/shubham/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude'
NODE = '/Users/shubham/.nvm/versions/node/v24.19.0/bin/node'
ADAPTER = '/Users/shubham/.codex/ruflo-state/swasthadisha/adapters/57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d/ruflo-local.mjs'
RUFLO = '/Users/shubham/.codex/runtimes/ruflo/3.75.0/node_modules/@claude-flow/cli/bin/cli.js'
ENVIRONMENT = {'HOME': '/Users/shubham', 'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}
ROOT = Path('/private/tmp/swasthadisha-parallel-p1qom53w/claude-review-window')
QA = ROOT / 'output/qa/week2-local-review-link'
CANDIDATE_SHA = '14f64e0167ee81cc47862ae15f6732d93a2a288e01f953d5407fec3d907e53f7'
MANIFEST_SHA = '8ef9b22e6a52774ca1b3aa0661b3d11690bfb6ce9d9a709f14b3d5cae358ec6e'
PROOF_PATH = Path('/private/tmp/sd-claude-ruflo-review-startup-proof.json')
APPROVAL_PATH = Path('/private/tmp/sd-claude-ruflo-review-approval.json')
PINNED_FILES = {
    CLI: 'a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450',
    NODE: '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1',
    ADAPTER: '57c226be79e9b832e6ee2b7122d387102b878f0ecaa7862a6fd65c4b64268b4d',
    RUFLO: '5b65e02510e0d94174a557ce77c5a62c5e19093ec4d1d9b39ddfdfa93932a1f7',
    '/Users/shubham/.codex/runtimes/ruflo/3.75.0/package-lock.json': '8ac77ad0a7a64b698abe9566f12fc2d7bd583741bcf9167e5cc5cb6c7d19f646',
    '/Users/shubham/.codex/runtimes/ruflo/3.75.0/node_modules/@claude-flow/cli/package.json': 'a898ebf657810d9894d6505db55c11a94ca8b1766c08468552d41e4378beeaf0',
}
FAILURE_CODES = frozenset('''UNEXPECTED_OPERATOR_ERROR INPUT_REJECTED RECEIPT_REJECTED
PREFLIGHT_BLOCKED AUTH_UNKNOWN AUTH_UNRESOLVED AUTH_REQUIRED CLAIM_COLLISION
CLI_IDENTITY_UNKNOWN CHILD_OBSERVATION_UNKNOWN CHILD_IDENTITY_UNKNOWN
AMBIGUOUS_ADAPTER UNKNOWN_CHILD UNKNOWN_ADAPTER AMBIGUOUS_RUFLO UNKNOWN_RUFLO
TOOL_RESULT_REJECTED TOOL_SCHEMA_UNSUPPORTED STREAM_SESSION_MISMATCH
CLIENT_INIT_UNSUPPORTED MODEL_TOOL_SCOPE MCP_INIT_UNSUPPORTED STREAM_ORDER
MODEL_MISMATCH STREAM_SCHEMA_UNSUPPORTED REVIEW_INCOMPLETE REVIEW_RESULT_REJECTED
TOOL_SEQUENCE_REJECTED TOOL_SCOPE_REJECTED ACK_MISMATCH REVIEW_MESSAGE_MISSING
TOOL_CORRELATION INBOX_MISMATCH CHALLENGE_NOT_RECEIVED SEND_NOT_ACKNOWLEDGED
REVIEW_DECLARATION_REJECTED REVIEW_RESULT_MISMATCH
PROCESS_CAPTURE_INCOMPLETE PROCESS_IDENTITY_CHANGED INPUT_CLOSE_FAILED
TIMEOUT INTERRUPTED STDOUT_LIMIT STDERR_LIMIT FRAME_LIMIT PIPE_FAILURE
CLEANUP_UNRESOLVED CLIENT_EXIT_FAILED SOURCE_DRIFT RESERVATION_CHANGED'''.split())
UNRESOLVED_CODES = frozenset('''AUTH_UNRESOLVED CLI_IDENTITY_UNKNOWN CHILD_OBSERVATION_UNKNOWN
CHILD_IDENTITY_UNKNOWN AMBIGUOUS_ADAPTER UNKNOWN_CHILD UNKNOWN_ADAPTER AMBIGUOUS_RUFLO
UNKNOWN_RUFLO PROCESS_CAPTURE_INCOMPLETE PROCESS_IDENTITY_CHANGED CLEANUP_UNRESOLVED'''.split())


class ReviewError(Exception):
    """Only fixed internal code literals may reach a public result."""
    def __init__(self, code):
        self.code = code if code in FAILURE_CODES else 'UNEXPECTED_OPERATOR_ERROR'
        super().__init__(self.code)


def need(ok, code):
    if not ok:
        raise ReviewError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def exact(value, names):
    return isinstance(value, dict) and set(value) == set(names)


def regular(path, private=False, limit=2 * 1024 * 1024):
    path = Path(path)
    metadata = path.lstat()
    need(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1
         and metadata.st_size <= limit, 'INPUT_REJECTED')
    if private:
        need(metadata.st_uid == os.getuid() and stat.S_IMODE(metadata.st_mode) == 0o600, 'INPUT_REJECTED')
    data = path.read_bytes()
    after = path.lstat()
    need((metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns)
         == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), 'SOURCE_DRIFT')
    return data


def validate_startup(proof, candidate):
    keys = ['schema', 'clientSha256', 'candidateSha256', 'authoritative', 'flagsVerified',
            'restrictedExcludesUserProjectLocal', 'managedPolicyPreserved', 'managedCommandHooks',
            'managedStatusLineCommands', 'managedPlugins', 'managedCredentialHelpers',
            'providerOverrides', 'unreviewedMcpServers', 'dynamicWorkflows', 'streamSchema',
            'supportedEvidenceSha256', 'publicProfileSha256', 'preservationSha256']
    need(exact(proof, keys) and proof['schema'] == 'SD-CLAUDE-STARTUP-PROOF-1'
         and proof['clientSha256'] == candidate['executableSha256']
         and proof['candidateSha256'] == CANDIDATE_SHA
         and all(proof[k] is True for k in ['authoritative', 'flagsVerified',
            'restrictedExcludesUserProjectLocal', 'managedPolicyPreserved'])
         and all(type(proof[k]) is int and proof[k] == 0 for k in ['managedCommandHooks',
            'managedStatusLineCommands', 'managedPlugins', 'managedCredentialHelpers',
            'providerOverrides', 'unreviewedMcpServers', 'dynamicWorkflows'])
         and proof['streamSchema'] == 'CLAUDE_2_1_322_DOCUMENTED_INIT_MESSAGE_TOOL_RESULT'
         and proof['publicProfileSha256'] == 'da259bf7c092b85ec3966dccf400d5053ffc33d82ec3e6c453a3ef3c39b48fc4'
         and all(isinstance(proof[k], str) and len(proof[k]) == 64
                 and all(c in '0123456789abcdef' for c in proof[k]) for k in
                 ['supportedEvidenceSha256', 'publicProfileSha256', 'preservationSha256']), 'PREFLIGHT_BLOCKED')


def validate_receipt(receipt, expected):
    need(exact(receipt, [*expected, 'reviewers'])
         and all(receipt[k] == v for k, v in expected.items()), 'RECEIPT_REJECTED')
    reviewers = receipt['reviewers']
    need(isinstance(reviewers, list) and len(reviewers) == 2
         and all(exact(r, ['agent', 'decision'])
                 and r['decision'] == 'APPROVE_ONE_OWNED_CLAUDE_REVIEW' for r in reviewers)
         and {r['agent'] for r in reviewers} == REVIEWERS, 'RECEIPT_REJECTED')


def load_fixed(*, reader=None, proof_exists=None, directory_reader=None):
    """Read only enumerated public inputs and externally reviewed safe metadata.

    Real managed-policy metadata/effective-effort schemas are not invented here.
    A missing authoritative proof is a blocked preflight, before auth/client use.
    """
    fake = reader is not None or proof_exists is not None or directory_reader is not None
    need(not fake or (callable(reader) and callable(proof_exists) and callable(directory_reader)), 'INPUT_REJECTED')
    read = reader if fake else regular
    exists = proof_exists if fake else PROOF_PATH.exists
    read_directory = directory_reader if fake else directory_identity
    candidate_bytes = read(QA / 'claude-review-invocation.json')
    manifest_bytes = read(QA / 'claude-review-input-manifest.json')
    need(digest(candidate_bytes) == CANDIDATE_SHA and digest(manifest_bytes) == MANIFEST_SHA, 'INPUT_REJECTED')
    candidate = json.loads(candidate_bytes)
    manifest = json.loads(manifest_bytes)
    need(candidate['environment'] == ENVIRONMENT and candidate['executable'] == CLI
         and candidate['timeoutSeconds'] == REVIEW_SECONDS and candidate['maxTurns'] == MAX_TURNS
         and candidate['sourceCommit'] == manifest['sourceCommit'] == REVIEW_SOURCE
         and candidate['evidenceCommit'] == manifest['evidenceCommit'] == REVIEW_EVIDENCE
         and manifest['descriptorSha256'] == REVIEW_TEMPLATE
         and manifest['fileCount'] == SNAPSHOT_FILE_COUNT
         and candidate['stdinFile'] == manifest['privateInput']
         and candidate['stdinSha256'] == manifest['inputSha256']
         and candidate['inputManifestSha256'] == MANIFEST_SHA
         and candidate['mcpConfigSha256'] == manifest['mcpConfigSha256'], 'INPUT_REJECTED')
    sid = candidate['sessionId']
    need(str(uuid.UUID(sid, version=4)) == sid and candidate['argv'][-2:] == ['--session-id', sid], 'INPUT_REJECTED')
    for path, expected in PINNED_FILES.items():
        need(digest(read(path, limit=512 * 1024 * 1024)) == expected, 'SOURCE_DRIFT')
    payload = read(candidate['stdinFile'], private=True)
    need(len(payload) == candidate['stdinBytes'] and digest(payload) == candidate['stdinSha256'], 'INPUT_REJECTED')
    snapshot = json.loads(payload)
    need(isinstance(snapshot.get('files'), list) and len(snapshot['files']) == SNAPSHOT_FILE_COUNT
         and len({f['path'] for f in snapshot['files']}) == SNAPSHOT_FILE_COUNT
         and [{k: v for k, v in f.items() if k != 'content'} for f in snapshot['files']] == manifest['files']
         and all(exact(f, ['kind', 'path', 'sha256', 'content'])
                 and digest(f['content'].encode()) == f['sha256'] for f in snapshot['files'])
         and digest(snapshot['instruction'].encode()) == manifest['promptSha256'], 'INPUT_REJECTED')
    need(digest(read(QA / 'claude-review-mcp.json')) == candidate['mcpConfigSha256']
         and digest(read(QA / 'CLAUDE_CLI_REVIEW_PROMPT.md')) == manifest['promptSha256'], 'SOURCE_DRIFT')
    link_files = [f for f in snapshot['files'] if f['kind'] == 'SAFE_PENDING_LINK_METADATA']
    need(len(link_files) == 1, 'INPUT_REJECTED')
    link_bytes = read(link_files[0]['path'], private=True)
    need(digest(link_bytes) == link_files[0]['sha256'], 'SOURCE_DRIFT')
    link = json.loads(link_bytes)
    need(link.get('actual_claude_extension_acknowledged') is False
         and link.get('team') == TEAM and link.get('claude_agent') == MEMBER
         and link.get('expected_reply') == 'CLAUDE_EXTENSION_ACK:' + link.get('nonce', ''), 'INPUT_REJECTED')
    # These are safe reviewed projections, never user/Claude/Codex config values.
    need(exists(), 'PREFLIGHT_BLOCKED')
    proof_bytes = read(PROOF_PATH, private=True)
    proof = json.loads(proof_bytes)
    validate_startup(proof, candidate)
    output_device, output_inode = read_directory(candidate['privateOutputDirectory'])
    expected = {'schema': 'SD-CLAUDE-REVIEW-APPROVAL-1',
                'decision': 'APPROVE_ONE_OWNED_CLAUDE_REVIEW', 'operatorSha256': digest(read(__file__)),
                'testsSha256': digest(read(Path(__file__).with_name('claude-ruflo-review.test.py'))),
                'contractSha256': '97dc92ae0469a346eb2094833cc4c697b4c7ad105a753dc086a52289544895a9',
                'amendmentSha256': AMENDMENT_SHA,
                'candidateSha256': CANDIDATE_SHA, 'inputManifestSha256': MANIFEST_SHA,
                'stdinSha256': candidate['stdinSha256'], 'startupProofSha256': digest(proof_bytes),
                'sourceCommit': candidate['sourceCommit'], 'evidenceCommit': candidate['evidenceCommit'],
                'sessionId': sid, 'outputDirectory': candidate['privateOutputDirectory'],
                'outputDevice': output_device, 'outputInode': output_inode}
    receipt_bytes = read(APPROVAL_PATH, private=True)
    validate_receipt(json.loads(receipt_bytes), expected)
    return {'candidate': candidate, 'payload': payload, 'sessionId': sid, 'link': link,
            'startupProof': proof, 'expectedReceipt': expected, 'approvalSha256': digest(receipt_bytes)}


def preservation(command):
    """Only public protected source/archive bytes and read-only Git metadata."""
    main = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha')
    archive = main / 'documentation/planning/implementation/handover/2026-11-10-local-extensions'
    manifest = regular(archive / 'artifacts.sha256.json')
    need(digest(manifest) == '8db501e58ccb11df861273392228c947668c6fe477f7fee43a03a170a45acff5', 'SOURCE_DRIFT')
    for name, expected in json.loads(manifest).items():
        need(Path(name).name == name and digest(regular(archive / name)) == expected, 'SOURCE_DRIFT')
    frozen = json.loads(regular(archive / 'review-input.json'))
    for name, expected in frozen['files_sha256'].items():
        need(digest(regular(main / name)) == expected, 'SOURCE_DRIFT')
    for name, expected in {'SESSION_HANDOVER.md': 'a3506a23605ac1092eada9c3c9c1bf194f56873b8100275a96beea15d07314ca',
                           'START_NEXT_SESSION.txt': 'a5770aeea5f8c10d0c657da3e2389e2c6acd3bba22a436a7256acf86b6ad5e7b'}.items():
        need(digest(regular(main / 'documentation/planning/implementation' / name)) == expected, 'SOURCE_DRIFT')
    args = ['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', 'diff',
            '--no-ext-diff', '--no-textconv', '--cached', '--binary', '--full-index']
    patch = command(args, main)
    need(digest(patch) == frozen['patch_sha256'], 'SOURCE_DRIFT')


def directory_identity(path, require_empty=False):
    path = Path(path)
    metadata = path.lstat()
    need(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid()
         and stat.S_IMODE(metadata.st_mode) == 0o700
         and (not require_empty or not any(path.iterdir())), 'RESERVATION_CHANGED')
    return metadata.st_dev, metadata.st_ino


def validate_live_sources(bundle, read, command):
    """Mandatory read/metadata ports; repeat before either native start/acceptance."""
    need(callable(read) and callable(command), 'INPUT_REJECTED')
    candidate = bundle['candidate']
    root = Path(candidate['cwd'])
    prefix = ['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false']
    need(command([*prefix, 'rev-parse', 'HEAD'], root).decode().strip() == candidate['sourceCommit']
         and command([*prefix, 'status', '--porcelain'], root) == b'', 'SOURCE_DRIFT')
    for row in json.loads(bundle['payload'])['files']:
        if row['kind'] != 'DESCRIPTOR_SUMMARY':
            need(digest(read(row['path'], limit=4 * 1024 * 1024)) == row['sha256'], 'SOURCE_DRIFT')


@dataclass(frozen=True)
class Identity:
    pid: int
    parent: int
    group: int
    started: str
    executable: str


def select_chain(cli, held_pid, operator_pid, descendants, adapter_args, ruflo_args):
    """OS argument strings select children only; the held Popen proves CLI argv.

    OS display text cannot reconstruct empty CLI arguments. Descendant argument
    displays are accepted only after parent/group/start ownership admission and
    only because their frozen argument vectors have no spaces/empty values.
    """
    need(isinstance(cli, Identity) and cli.pid == held_pid and cli.parent == operator_pid
         and cli.group == held_pid and cli.executable in {CLI, Path(CLI).name}
         and isinstance(cli.started, str) and bool(cli.started), 'CLI_IDENTITY_UNKNOWN')
    need(isinstance(descendants, list), 'CHILD_OBSERVATION_UNKNOWN')
    def birth(identity):
        try:
            return datetime.strptime(identity.started, '%a %b %d %H:%M:%S %Y')
        except (ValueError, TypeError):
            raise ReviewError('CHILD_IDENTITY_UNKNOWN') from None
    parent_birth = birth(cli)
    by_pid = {}
    for row in descendants:
        need(exact(row, ['identity', 'argumentDisplay']) and isinstance(row['identity'], Identity),
             'CHILD_OBSERVATION_UNKNOWN')
        identity = row['identity']
        need(identity.pid > 1 and identity.pid not in by_pid and identity.group == cli.group
             and birth(identity) >= parent_birth, 'CHILD_IDENTITY_UNKNOWN')
        by_pid[identity.pid] = row
    adapters = [r for r in descendants if r['identity'].parent == cli.pid]
    need(len(adapters) <= 1, 'AMBIGUOUS_ADAPTER')
    if not adapters:
        need(not descendants, 'UNKNOWN_CHILD')
        return {'cli': cli, 'adapter': None, 'ruflo': None}
    adapter = adapters[0]
    need(adapter['argumentDisplay'] == ' '.join(adapter_args)
         and adapter['identity'].executable in {NODE, Path(NODE).name}, 'UNKNOWN_ADAPTER')
    children = [r for r in descendants if r['identity'].parent == adapter['identity'].pid]
    need(len(children) <= 1, 'AMBIGUOUS_RUFLO')
    known = {adapter['identity'].pid}
    if children:
        child = children[0]
        need(child['argumentDisplay'] == ' '.join(ruflo_args)
             and child['identity'].executable in {NODE, Path(NODE).name}
             and birth(child['identity']) >= birth(adapter['identity']), 'UNKNOWN_RUFLO')
        known.add(child['identity'].pid)
    need(set(by_pid) == known, 'UNKNOWN_CHILD')
    return {'cli': cli, 'adapter': adapter['identity'],
            'ruflo': children[0]['identity'] if children else None}


def decode_tool_result(block):
    need(isinstance(block, dict) and block.get('type') == 'tool_result'
         and block.get('is_error', False) is False, 'TOOL_RESULT_REJECTED')
    value = block.get('content')
    # Supported SDK text/MCP envelopes only. Never stringify malformed content.
    for _ in range(6):
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                raise ReviewError('TOOL_SCHEMA_UNSUPPORTED') from None
        elif isinstance(value, list):
            need(len(value) == 1 and isinstance(value[0], dict)
                 and value[0].get('type') == 'text' and isinstance(value[0].get('text'), str),
                 'TOOL_SCHEMA_UNSUPPORTED')
            value = value[0]['text']
        elif isinstance(value, dict) and 'content' in value:
            need(value.get('isError') is False, 'TOOL_RESULT_REJECTED')
            value = value['content']
        else:
            break
    need(isinstance(value, dict) and value.get('success') is not False and not value.get('error'),
         'TOOL_SCHEMA_UNSUPPORTED')
    return value


def declared_review(text):
    """Bounded protocol/outcome correlation; semantic acceptance stays independent."""
    need(isinstance(text, str) and 0 < len(text.encode()) <= 131072, 'REVIEW_DECLARATION_REJECTED')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'REVIEW_DECLARATION_REJECTED')
            result[key] = value
        return result
    try:
        value = json.loads(text, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise ReviewError('REVIEW_DECLARATION_REJECTED') from None
    need(exact(value, ['schema', 'outcome', 'sourceCommit', 'templateSha256', 'evidenceCommit', 'review', 'limitations'])
         and value['schema'] == 'SD-FOCUSED-REVIEW-1'
         and isinstance(value['outcome'], str)
         and value['outcome'] in {'ACCEPT_FOCUSED_AUTH_API_EVIDENCE', 'REQUEST_CHANGES', 'REVIEW_INCOMPLETE'}
         and value['sourceCommit'] == REVIEW_SOURCE and value['templateSha256'] == REVIEW_TEMPLATE
         and value['evidenceCommit'] == REVIEW_EVIDENCE
         and isinstance(value['review'], str) and 80 <= len(value['review'].strip()) <= 32768
         and isinstance(value['limitations'], str) and 40 <= len(value['limitations'].strip()) <= 8192,
         'REVIEW_DECLARATION_REJECTED')
    return value


class StreamEvidence:
    """Private stream analysis. Effective-effort protocol is deliberately unknown.

    Fake fixtures exercise this admitted shape; actual supported-schema evidence
    is an additional invocation prerequisite, never supplied by these fixtures.
    """
    def __init__(self, session, link):
        self.session = session
        self.link = link
        self.initialized = False
        self.calls = []
        self.pending = None
        self.result = None
        self.models = set()
        self.declared = None

    def accept(self, event):
        need(isinstance(event, dict) and event.get('session_id') == self.session,
             'STREAM_SESSION_MISMATCH')
        kind = event.get('type')
        if kind == 'system':
            need(not self.initialized and event.get('subtype') == 'init'
                 and event.get('model') == MODEL and event.get('claude_code_version') == '2.1.322',
                 'CLIENT_INIT_UNSUPPORTED')
            # Vendor docs reserve non-null init.effort for Remote Control,
            # omitting it from application print streams. It cannot certify
            # this fixed local CLI route, even when the value claims max.
            need(event.get('effort') is None, 'CLIENT_INIT_UNSUPPORTED')
            tools = event.get('tools')
            need(isinstance(tools, list) and len(tools) == len(set(tools))
                 and set(tools) in [{INBOX, SEND}, {INBOX, SEND, 'EndConversation'}], 'MODEL_TOOL_SCOPE')
            servers = event.get('mcp_servers')
            need(isinstance(servers, list) and len(servers) == 1
                 and servers[0].get('name') == 'ruflo' and servers[0].get('status') == 'connected',
                 'MCP_INIT_UNSUPPORTED')
            self.initialized = True
        elif kind == 'assistant':
            need(self.initialized and self.result is None, 'STREAM_ORDER')
            message = event.get('message', {})
            need(message.get('model') == MODEL and isinstance(message.get('content'), list), 'MODEL_MISMATCH')
            self.models.add(message['model'])
            for block in message['content']:
                need(isinstance(block, dict), 'STREAM_SCHEMA_UNSUPPORTED')
                if block.get('type') == 'tool_use':
                    self._call(block)
                else:
                    need(block.get('type') in {'text', 'thinking', 'redacted_thinking'}, 'STREAM_SCHEMA_UNSUPPORTED')
        elif kind == 'user':
            need(self.initialized and self.result is None and self.pending is not None, 'STREAM_ORDER')
            blocks = event.get('message', {}).get('content')
            need(isinstance(blocks, list) and len(blocks) == 1, 'TOOL_SCHEMA_UNSUPPORTED')
            block = blocks[0]
            need(block.get('tool_use_id') == self.pending['id'], 'TOOL_CORRELATION')
            self._response(decode_tool_result(block))
        elif kind == 'result':
            need(self.initialized and self.result is None and self.pending is None and len(self.calls) == 3,
                 'REVIEW_INCOMPLETE')
            need(event.get('subtype') == 'success' and event.get('is_error') is False
                 and event.get('permission_denials') == []
                 and isinstance(event.get('result'), str) and event['result'].strip()
                 and type(event.get('num_turns')) is int and 0 < event['num_turns'] <= MAX_TURNS
                 and set(event.get('modelUsage', {})) == {MODEL}, 'REVIEW_RESULT_REJECTED')
            need(declared_review(event['result']) == self.declared, 'REVIEW_RESULT_MISMATCH')
            self.result = {'sha256': digest(event['result'].encode()), 'bytes': len(event['result'].encode())}
        else:
            raise ReviewError('STREAM_SCHEMA_UNSUPPORTED')

    def _call(self, block):
        need(self.pending is None and len(self.calls) < 3 and isinstance(block.get('id'), str)
             and block['id'] and all(row['id'] != block['id'] for row in self.calls), 'TOOL_SEQUENCE_REJECTED')
        index = len(self.calls)
        args = block.get('input')
        if index == 0:
            need(block.get('name') == INBOX and args == {'team': TEAM, 'agent': MEMBER, 'peek': True},
                 'TOOL_SCOPE_REJECTED')
        else:
            need(block.get('name') == SEND and exact(args, ['team', 'from', 'to', 'message'])
                 and args['team'] == TEAM and args['from'] == MEMBER and args['to'] == 'codex-lead'
                 and isinstance(args['message'], str), 'TOOL_SCOPE_REJECTED')
            if index == 1:
                need(args['message'] == self.link['expected_reply'], 'ACK_MISMATCH')
            else:
                self.declared = declared_review(args['message'])
        self.pending = {'id': block['id'], 'name': block['name'], 'args': args}

    def _response(self, value):
        call = self.pending
        if not self.calls:
            need(value.get('team') == TEAM and value.get('agent') == MEMBER
                 and value.get('peek') is True and isinstance(value.get('messages'), list), 'INBOX_MISMATCH')
            found = False
            for message in value['messages']:
                if not isinstance(message, dict) or any(message.get(k) != v for k, v in
                    {'teamId': TEAM, 'from': 'codex-lead', 'to': MEMBER}.items()):
                    continue
                try:
                    content = json.loads(message.get('content', ''))
                    found |= isinstance(content, dict) and content.get('nonce') == self.link['nonce'] \
                        and content.get('reply_to') == 'codex-lead' \
                        and content.get('expected_reply') == self.link['expected_reply']
                except (ValueError, TypeError):
                    continue
            need(found, 'CHALLENGE_NOT_RECEIVED')
        else:
            args = call['args']
            need(value.get('success') is True and value.get('action') == 'send'
                 and value.get('recipients') == ['codex-lead']
                 and isinstance(value.get('message'), dict)
                 and all(value['message'].get(k) == v for k, v in {'teamId': TEAM, 'from': MEMBER,
                    'to': 'codex-lead', 'content': args['message']}.items()), 'SEND_NOT_ACKNOWLEDGED')
        self.calls.append({'id': call['id'], 'method': call['name'], 'acknowledged': True})
        self.pending = None

    def summary(self):
        need(self.result is not None and self.models == {MODEL} and len(self.calls) == 3, 'REVIEW_INCOMPLETE')
        return {'model': MODEL, 'session': self.session, 'requestedEffort': 'max',
                'effectiveEffort': 'UNPROVEN', 'mailboxCalls': len(self.calls),
                'reviewOutcome': self.declared['outcome'], 'sourceCommit': REVIEW_SOURCE,
                'templateSha256': REVIEW_TEMPLATE, 'evidenceCommit': REVIEW_EVIDENCE,
                'reviewTextSha256': self.result['sha256'], 'reviewTextBytes': self.result['bytes'],
                'actualClaudeExtensionACK': False}


def cleanup_owned(process, captured, ports, allow_escalation=True):
    """Exact per-identity effects only; ports must be explicit real or fake."""
    need(set(captured) == {'cli', 'adapter', 'ruflo'}, 'PROCESS_CAPTURE_INCOMPLETE')
    actions = []
    errors = []
    try:
        ports.close_input(process)
    except Exception:
        errors.append('INPUT_CLOSE_FAILED')
    try:
        ports.wait_grace(process, EOF_SECONDS)
    except Exception:
        errors.append('CLEANUP_UNRESOLVED')
    # A native held handle proves CLI ownership; children require a fresh full
    # unchanged fingerprint. Unknown/reparented children are never signalled.
    for name in ['cli', 'adapter', 'ruflo']:
        identity = captured[name]
        if identity is None:
            errors.append('PROCESS_CAPTURE_INCOMPLETE')
            continue
        for sig, grace in [(signal.SIGTERM, 3), (signal.SIGKILL, 2)]:
            try:
                observed = ports.identity(identity.pid)
            except Exception:
                errors.append('CLEANUP_UNRESOLVED')
                break
            if observed is None:
                break
            if observed != identity or not allow_escalation or errors:
                errors.append('PROCESS_IDENTITY_CHANGED')
                break
            try:
                ports.signal_exact(process, name, identity, sig)
                actions.append({'kind': name, 'pid': identity.pid, 'signal': int(sig)})
                ports.wait_grace(process, grace)
            except Exception:
                errors.append('CLEANUP_UNRESOLVED')
                break
    absent = {}
    for name, identity in captured.items():
        try:
            absent[name] = identity is not None and ports.identity(identity.pid) is None
        except Exception:
            absent[name] = False
    try:
        group_empty = ports.group_empty(process)
    except Exception:
        group_empty = False
    return {'safe': not errors and not actions and all(absent.values()) and group_empty,
            'absent': absent, 'groupEmpty': group_empty, 'signals': actions,
            'errors': errors, 'forced': bool(actions)}


def auth_projection(exit_code, payload):
    """Account-bearing fields are never returned, formatted or retained."""
    need(isinstance(payload, dict), 'AUTH_UNKNOWN')
    fields = {key: payload.get(key) for key in ['loggedIn', 'authMethod', 'apiProvider']}
    if exit_code == 1 and fields['loggedIn'] is False \
            and fields['authMethod'] == 'none' and fields['apiProvider'] == 'firstParty':
        return 'AUTH_REQUIRED', {'loggedIn': False, 'authMethod': 'none', 'apiProvider': 'firstParty'}
    need(exit_code == 0 and fields['loggedIn'] is True
         and fields['authMethod'] == 'claude.ai' and fields['apiProvider'] == 'firstParty', 'AUTH_UNKNOWN')
    return 'AUTHENTICATED', {'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty'}


def public_processes(captured):
    result = {}
    for name in ['cli', 'adapter', 'ruflo']:
        value = captured.get(name)
        if not isinstance(value, Identity) or value.executable not in {CLI, NODE, Path(CLI).name, Path(NODE).name}:
            result[name] = None
            continue
        try:
            datetime.strptime(value.started, '%a %b %d %H:%M:%S %Y')
            need(all(type(v) is int and v > 1 for v in [value.pid, value.parent, value.group]), 'CHILD_IDENTITY_UNKNOWN')
        except (ValueError, TypeError, ReviewError):
            result[name] = None
            continue
        result[name] = {'pid': value.pid, 'parent': value.parent, 'group': value.group,
                        'started': value.started, 'executable': value.executable}
    return result


def cleanup_auth(process, native):
    """Bounded held-Popen cleanup; no adoption and no OS-query prerequisite to EOF.

    The original unreaped Popen proves this one auth process, even when its first
    OS observation fails. Its own send_signal implementation protects PID reuse.
    Unknown children are never selected, adopted or signalled.
    """
    errors = []; signals = []; exit_code = None
    def error():
        errors.append('AUTH_UNRESOLVED')
    try:
        live = process.poll() is None
    except (Exception, KeyboardInterrupt):
        live = None; error()
    if live is True:
        for sig, seconds in [(signal.SIGTERM, 3), (signal.SIGKILL, 2)]:
            try:
                if process.poll() is not None:
                    break
                process.send_signal(sig)
                signals.append(int(sig))
                try:
                    process.wait(timeout=seconds)
                except subprocess.TimeoutExpired:
                    continue
            except (Exception, KeyboardInterrupt):
                error()
    try:
        exit_code = process.wait(timeout=2)
        if type(exit_code) is not int:
            exit_code = None; error()
    except (Exception, KeyboardInterrupt):
        error()
    try:
        absent = native.identity(process.pid) is None
    except (Exception, KeyboardInterrupt):
        absent = None; error()
    try:
        group_empty = native.group_empty(process)
        if type(group_empty) is not bool:
            group_empty = None; error()
    except (Exception, KeyboardInterrupt):
        group_empty = None; error()
    try:
        native.auth_close(process)
        pipes_closed = True
    except (Exception, KeyboardInterrupt):
        pipes_closed = False; error()
    return {'safe': not errors and not signals and absent is True and group_empty is True
            and pipes_closed and exit_code is not None,
            'pidAbsent': absent, 'groupEmpty': group_empty, 'exit': exit_code,
            'pipesClosed': pipes_closed, 'signals': signals, 'errors': errors}


def owned_auth_status(owner, native):
    """Actual auth lifecycle shared by production and hard-fake lifecycle tests."""
    need(all(callable(getattr(native, name, None)) for name in
             ['auth_start', 'auth_capture', 'identity', 'group_empty', 'auth_close']), 'AUTH_UNRESOLVED')
    need(getattr(owner, 'auth_process', None) is None, 'AUTH_UNRESOLVED')
    record = {'requested': True, 'started': False, 'startUnconfirmed': False, 'pid': None,
              'identity': None, 'firstFailure': None, 'cleanup': None}
    owner.auth_record = record
    first = None; result = None
    try:
        # Register immediately: every subsequent observation/allocation is inside
        # this protected region and finally always retains/cleans this handle.
        owner.auth_process = native.auth_start()
        process = owner.auth_process
        record['started'] = True
        need(type(process.pid) is int and process.pid > 1, 'AUTH_UNRESOLVED')
        record['pid'] = process.pid
        identity = native.identity(process.pid)
        need(isinstance(identity, Identity) and identity.pid == process.pid
             and identity.parent == os.getpid() and identity.group == process.pid
             and identity.executable in {CLI, Path(CLI).name}, 'AUTH_UNRESOLVED')
        record['identity'] = public_processes({'cli': identity})['cli']
        need(record['identity'] is not None, 'AUTH_UNRESOLVED')
        raw = native.auth_capture(process)
        need(isinstance(raw, bytes) and len(raw) <= MAX_STDERR, 'AUTH_UNKNOWN')
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ReviewError('AUTH_UNKNOWN') from None
        result = process.wait(timeout=2), payload
    except (Exception, KeyboardInterrupt) as caught:
        first = caught.code if isinstance(caught, ReviewError) else 'AUTH_UNRESOLVED'
        if owner.auth_process is None:
            record['startUnconfirmed'] = True
    finally:
        if owner.auth_process is not None:
            record['cleanup'] = cleanup_auth(owner.auth_process, native)
            if not record['cleanup']['safe'] and first is None:
                first = 'AUTH_UNRESOLVED'
        record['firstFailure'] = first
    if first:
        raise ReviewError(first)
    need(result is not None, 'AUTH_UNRESOLVED')
    return result


def run_operator(bundle, ports):
    """Mandatory ports. No real-port defaults and no domain execution seam."""
    required = {'admit', 'auth', 'reserve', 'start', 'collect', 'revalidate', 'close_input',
                'wait_grace', 'identity', 'signal_exact', 'group_empty', 'save'}
    need(all(callable(getattr(ports, name, None)) for name in required), 'INPUT_REJECTED')
    report = {'schema': 'SD-CLAUDE-OWNED-REVIEW-1', 'status': 'NOT_STARTED',
              'clientKind': 'local-bundled-CLI', 'authChecks': 0, 'reviewStarts': 0,
              'reviewRequested': False,
              'reviewCompleted': 0, 'firstFailure': None, 'cleanup': None,
              'requestedEffort': 'max', 'effectiveEffort': 'UNPROVEN',
              'actualClaudeExtensionACK': False}
    process = None
    captured = {'cli': None, 'adapter': None, 'ruflo': None}
    try:
        ports.admit(bundle)
        report['authChecks'] = 1
        status, projection = auth_projection(*ports.auth())
        report['auth'] = projection
        if status == 'AUTH_REQUIRED':
            report['status'] = status
            return report
        ports.revalidate(bundle)
        ports.reserve(bundle)
        ports.revalidate(bundle)
        report['reviewRequested'] = True
        process = ports.start(bundle)
        report['reviewStarts'] = 1
        evidence = StreamEvidence(bundle['sessionId'], bundle['link'])
        captured, exit_code = ports.collect(process, bundle, evidence, captured)
        need(all(captured.values()), 'PROCESS_CAPTURE_INCOMPLETE')
        need(exit_code == 0, 'CLIENT_EXIT_FAILED')
        report['evidence'] = evidence.summary()
        need(report['evidence']['reviewOutcome'] != 'REVIEW_INCOMPLETE', 'REVIEW_INCOMPLETE')
        report['reviewCompleted'] = 1
        ports.revalidate(bundle)
    except (Exception, KeyboardInterrupt) as error:
        report['firstFailure'] = error.code if isinstance(error, ReviewError) else (
            'INTERRUPTED' if isinstance(error, KeyboardInterrupt) else 'UNEXPECTED_OPERATOR_ERROR')
    finally:
        report['processes'] = public_processes(captured)
        report['authProcess'] = getattr(ports, 'auth_record', None)
        if process is not None:
            try:
                report['cleanup'] = cleanup_owned(process, captured, ports,
                    allow_escalation=report['firstFailure'] not in {
                        'CHILD_IDENTITY_UNKNOWN', 'CHILD_OBSERVATION_UNKNOWN', 'UNKNOWN_CHILD',
                        'UNKNOWN_ADAPTER', 'UNKNOWN_RUFLO', 'AMBIGUOUS_ADAPTER', 'AMBIGUOUS_RUFLO',
                        'PROCESS_CAPTURE_INCOMPLETE', 'PROCESS_IDENTITY_CHANGED'})
            except Exception:
                report['cleanup'] = {'safe': False, 'errors': ['CLEANUP_UNRESOLVED']}
        if report['firstFailure']:
            report['status'] = 'FAILED_REVIEW_REQUIRED'
            if report['firstFailure'] in UNRESOLVED_CODES:
                report['status'] = 'UNRESOLVED'
            elif report['firstFailure'] in {'AUTH_UNKNOWN', 'PREFLIGHT_BLOCKED', 'REVIEW_INCOMPLETE'}:
                report['status'] = report['firstFailure']
        if report['reviewRequested'] and process is None:
            report['status'] = 'UNRESOLVED'
            report['reviewStartUnconfirmed'] = True
        if report['cleanup'] is not None and not report['cleanup']['safe']:
            report['status'] = 'UNRESOLVED'
            if not report['firstFailure']:
                report['firstFailure'] = 'CLEANUP_UNRESOLVED'
        elif report['reviewCompleted'] and not report['firstFailure']:
            # No supported effective-effort schema has been established. It is
            # impossible for this source to claim effective max or full success.
            report['status'] = 'REVIEW_RECEIVED_EFFORT_UNPROVEN'
        elif not report['firstFailure'] and report['status'] != 'AUTH_REQUIRED':
            report['status'] = 'REVIEW_INCOMPLETE'
        auth_record = report['authProcess']
        if isinstance(auth_record, dict) and auth_record.get('started') is True \
                and (not isinstance(auth_record.get('cleanup'), dict)
                     or auth_record['cleanup'].get('safe') is not True):
            report['status'] = 'UNRESOLVED'
            report['firstFailure'] = report['firstFailure'] or 'AUTH_UNRESOLVED'
        try:
            ports.save(report)
        except Exception:
            report['status'] = 'UNRESOLVED'
            report['firstFailure'] = report['firstFailure'] or 'RESERVATION_CHANGED'
    return report


class Frames:
    def __init__(self, evidence):
        self.evidence = evidence
        self.buffer = b''
        self.total = 0

    def feed(self, data):
        need(isinstance(data, bytes), 'STREAM_SCHEMA_UNSUPPORTED')
        self.total += len(data)
        need(self.total <= MAX_STDOUT, 'STDOUT_LIMIT')
        self.buffer += data
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            need(len(line) <= MAX_FRAME, 'FRAME_LIMIT')
            if line.strip():
                try:
                    event = json.loads(line.decode('utf-8'))
                except (ValueError, UnicodeError):
                    raise ReviewError('STREAM_SCHEMA_UNSUPPORTED') from None
                self.evidence.accept(event)
        need(len(self.buffer) <= MAX_FRAME, 'FRAME_LIMIT')

    def finish(self):
        need(not self.buffer.strip(), 'STREAM_SCHEMA_UNSUPPORTED')


class RealPorts:
    """All native/state effects are explicit here, unavailable in the unit entry."""
    def __init__(self):
        self.output = None
        self.output_identity = None
        self.files = {}
        self.file_identities = {}
        self.process = None
        self.capture_limited = False
        self.auth_record = None
        self.auth_process = None

    def command(self, args, cwd=None):
        result = subprocess.run(args, cwd=cwd, env={'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'},
                                stdin=subprocess.DEVNULL, capture_output=True, timeout=5, check=False)
        need(result.returncode == 0 and len(result.stdout) <= 2 * 1024 * 1024, 'PREFLIGHT_BLOCKED')
        return result.stdout

    def admit(self, bundle):
        need(bundle == load_fixed(), 'SOURCE_DRIFT')
        preservation(self.command)
        candidate = bundle['candidate']
        validate_live_sources(bundle, regular, self.command)
        directory_identity(Path(candidate['stdinFile']).parent)
        directory_identity(candidate['privateOutputDirectory'], require_empty=True)

    def revalidate(self, bundle):
        need(bundle == load_fixed(), 'SOURCE_DRIFT')
        preservation(self.command)
        validate_live_sources(bundle, regular, self.command)
        if self.output is not None:
            need(directory_identity(self.output) == self.output_identity, 'RESERVATION_CHANGED')
            for name, fd in self.files.items():
                current = (self.output / name).lstat()
                held = os.fstat(fd)
                need((current.st_dev, current.st_ino) == self.file_identities[name]
                     == (held.st_dev, held.st_ino) and current.st_nlink == 1
                     and current.st_uid == os.getuid() and stat.S_IMODE(current.st_mode) == 0o600,
                     'RESERVATION_CHANGED')

    def auth(self):
        return owned_auth_status(self, self)

    def auth_start(self):
        # No model input, MCP config or login flow on this fixed status command.
        return subprocess.Popen([CLI, 'auth', 'status'], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENVIRONMENT,
            cwd=ROOT, start_new_session=True, bufsize=0)

    def auth_capture(self, process):
        selector = None
        try:
            selector = selectors.DefaultSelector()
            data_by_stream = {process.stdout: bytearray(), process.stderr: bytearray()}
            for stream in data_by_stream:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            deadline = time.monotonic() + 15
            while selector.get_map():
                need(time.monotonic() < deadline, 'AUTH_UNRESOLVED')
                for key, _ in selector.select(timeout=0.05):
                    try:
                        chunk = os.read(key.fileobj.fileno(), 8192)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        need(len(data_by_stream[key.fileobj]) + len(chunk) <= MAX_STDERR, 'AUTH_UNRESOLVED')
                        data_by_stream[key.fileobj].extend(chunk)
            return bytes(data_by_stream[process.stdout])
        finally:
            if selector is not None:
                selector.close()

    def auth_close(self, process):
        first = None
        for stream in [process.stdout, process.stderr]:
            try:
                if stream is not None and not stream.closed:
                    stream.close()
            except (Exception, KeyboardInterrupt) as caught:
                first = first or caught
        if first is not None:
            raise ReviewError('AUTH_UNRESOLVED') from None

    def reserve(self, bundle):
        candidate = bundle['candidate']
        output = Path(candidate['privateOutputDirectory'])
        identity = directory_identity(output, require_empty=True)
        claim = Path('/private/tmp/sd-claude-ruflo-review-once-' + bundle['sessionId'] + '.claim.json')
        try:
            fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise ReviewError('CLAIM_COLLISION') from None
        with os.fdopen(fd, 'wb') as stream:
            stream.write(json.dumps({'sessionId': bundle['sessionId'], 'approvalSha256': bundle['approvalSha256'],
                'candidateSha256': CANDIDATE_SHA, 'stdinSha256': candidate['stdinSha256']}).encode())
            stream.flush()
            os.fsync(stream.fileno())
        need(directory_identity(output, require_empty=True) == identity, 'RESERVATION_CHANGED')
        self.output = output
        self.output_identity = identity
        for name in ['transcript.stream-json', 'stderr.txt', 'operator-result.json']:
            fd = os.open(output / name, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
            self.files[name] = fd
            item = os.fstat(fd)
            self.file_identities[name] = item.st_dev, item.st_ino

    def start(self, bundle):
        candidate = bundle['candidate']
        # Return immediately: no fallible observation/save between Popen and
        # registration in run_operator. Spawn uncertainty cannot claim zero.
        return subprocess.Popen([CLI, *candidate['argv']], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENVIRONMENT,
            cwd=candidate['cwd'], start_new_session=True, bufsize=0)

    def identity(self, pid):
        result = subprocess.run(['/bin/ps', '-ww', '-p', str(pid), '-o', 'pid=,ppid=,pgid=,lstart=,comm='],
            capture_output=True, stdin=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'}, timeout=2, check=False)
        if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
            return None
        need(result.returncode == 0 and not result.stderr.strip(), 'CHILD_OBSERVATION_UNKNOWN')
        rows = result.stdout.decode('utf-8').strip().splitlines()
        need(len(rows) == 1, 'CHILD_OBSERVATION_UNKNOWN')
        fields = rows[0].split(None, 8)
        need(len(fields) == 9 and all(value.isdecimal() for value in fields[:3]), 'CHILD_OBSERVATION_UNKNOWN')
        return Identity(*(int(v) for v in fields[:3]), ' '.join(fields[3:8]), fields[8])

    def child_pids(self, pid):
        result = subprocess.run(['/usr/bin/pgrep', '-P', str(pid)], capture_output=True,
            stdin=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'}, timeout=2, check=False)
        need(result.returncode in {0, 1} and not result.stderr.strip(), 'CHILD_OBSERVATION_UNKNOWN')
        values = result.stdout.decode('utf-8').split()
        need(all(value.isdecimal() for value in values) and len(values) == len(set(values)), 'CHILD_OBSERVATION_UNKNOWN')
        return [int(value) for value in values]

    def group_empty(self, process):
        # Metadata only; no broad argument/environment listing or group signal.
        rows = self.command(['/bin/ps', '-axo', 'pid=,pgid=']).decode('utf-8').splitlines()
        pairs = [row.split() for row in rows]
        need(all(len(row) == 2 and all(value.isdecimal() for value in row) for row in pairs), 'CHILD_OBSERVATION_UNKNOWN')
        return not any(int(group) == process.pid for _, group in pairs)

    def observe(self, process, captured):
        cli = self.identity(process.pid)
        if cli is None:
            return
        need(cli.pid == process.pid and cli.parent == os.getpid() and cli.group == process.pid
             and cli.executable in {CLI, Path(CLI).name}, 'CLI_IDENTITY_UNKNOWN')
        need(captured['cli'] in {None, cli}, 'CHILD_IDENTITY_UNKNOWN')
        captured['cli'] = cli
        rows = []
        for pid in self.child_pids(process.pid):
            identity = self.identity(pid)
            need(identity is not None and identity.parent == process.pid and identity.group == process.pid,
                 'CHILD_OBSERVATION_UNKNOWN')
            args = self.command(['/bin/ps', '-ww', '-p', str(pid), '-o', 'args=']).decode('utf-8').strip()
            need(self.identity(pid) == identity, 'CHILD_IDENTITY_UNKNOWN')
            rows.append({'identity': identity, 'argumentDisplay': args})
            for child_pid in self.child_pids(pid):
                child = self.identity(child_pid)
                need(child is not None and child.parent == pid and child.group == process.pid, 'CHILD_OBSERVATION_UNKNOWN')
                display = self.command(['/bin/ps', '-ww', '-p', str(child_pid), '-o', 'args=']).decode('utf-8').strip()
                need(self.identity(child_pid) == child and not self.child_pids(child_pid), 'CHILD_IDENTITY_UNKNOWN')
                rows.append({'identity': child, 'argumentDisplay': display})
        selected = select_chain(cli, process.pid, os.getpid(), rows,
            [NODE, ADAPTER], [NODE, RUFLO, 'mcp', 'start', '--transport', 'stdio'])
        for kind, identity in selected.items():
            if identity is not None:
                need(captured[kind] in {None, identity}, 'CHILD_IDENTITY_UNKNOWN')
                captured[kind] = identity

    def collect(self, process, bundle, evidence, captured):
        self.process = process
        self.observe(process, captured)
        need(captured['cli'] is not None, 'CLI_IDENTITY_UNKNOWN')
        frames = Frames(evidence)
        remaining = memoryview(bundle['payload'])
        stderr_bytes = 0
        deadline = time.monotonic() + REVIEW_SECONDS
        selector = selectors.DefaultSelector()
        for stream, event in [(process.stdin, selectors.EVENT_WRITE),
                              (process.stdout, selectors.EVENT_READ), (process.stderr, selectors.EVENT_READ)]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, event)
        try:
            while selector.get_map():
                need(time.monotonic() < deadline, 'TIMEOUT')
                self.observe(process, captured)
                for key, _ in selector.select(timeout=0.05):
                    stream = key.fileobj
                    if stream is process.stdin:
                        try:
                            sent = os.write(stream.fileno(), remaining[:65536])
                        except BlockingIOError:
                            continue
                        remaining = remaining[sent:]
                        if not remaining:
                            selector.unregister(stream)
                            stream.close()
                    else:
                        try:
                            data = os.read(stream.fileno(), 65536)
                        except BlockingIOError:
                            continue
                        if not data:
                            selector.unregister(stream)
                            continue
                        name = 'transcript.stream-json' if stream is process.stdout else 'stderr.txt'
                        if stream is process.stdout:
                            need(frames.total + len(data) <= MAX_STDOUT, 'STDOUT_LIMIT')
                        else:
                            stderr_bytes += len(data)
                            need(stderr_bytes <= MAX_STDERR, 'STDERR_LIMIT')
                        self.private_write(name, data)
                        if stream is process.stdout:
                            frames.feed(data)
                if process.poll() is not None and process.stdin in [k.fileobj for k in selector.get_map().values()]:
                    selector.unregister(process.stdin)
                    process.stdin.close()
            frames.finish()
            need(not remaining, 'PIPE_FAILURE')
            try:
                return captured, process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                raise ReviewError('TIMEOUT') from None
        finally:
            selector.close()

    def close_input(self, process):
        self.process = process
        if process.stdin and not process.stdin.closed:
            process.stdin.close()

    def wait_grace(self, process, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            process.poll()
            if self.group_empty(process):
                return
            # Drain bounded bytes after a failure to prevent pipe deadlock. Raw
            # diagnostics are never forwarded; exceeding a cap cannot pass.
            for stream in [process.stdout, process.stderr]:
                if stream is None or stream.closed:
                    continue
                try:
                    os.set_blocking(stream.fileno(), False)
                    data = os.read(stream.fileno(), 65536)
                    if data:
                        name = 'transcript.stream-json' if stream is process.stdout else 'stderr.txt'
                        limit = MAX_STDOUT if stream is process.stdout else MAX_STDERR
                        if os.fstat(self.files[name]).st_size + len(data) <= limit:
                            self.private_write(name, data)
                        else:
                            self.capture_limited = True
                except BlockingIOError:
                    pass
            time.sleep(0.05)

    def signal_exact(self, process, kind, identity, sig):
        need(self.identity(identity.pid) == identity and identity.group == process.pid, 'PROCESS_IDENTITY_CHANGED')
        if kind == 'cli':
            need(identity.pid == process.pid and process.poll() is None, 'PROCESS_IDENTITY_CHANGED')
            process.send_signal(sig)
        else:
            expected = [NODE, ADAPTER] if kind == 'adapter' else [NODE, RUFLO, 'mcp', 'start', '--transport', 'stdio']
            display = self.command(['/bin/ps', '-ww', '-p', str(identity.pid), '-o', 'args=']).decode().strip()
            need(display == ' '.join(expected) and self.identity(identity.pid) == identity, 'PROCESS_IDENTITY_CHANGED')
            os.kill(identity.pid, sig)

    def private_write(self, name, data):
        need(directory_identity(self.output) == self.output_identity, 'RESERVATION_CHANGED')
        metadata = (self.output / name).lstat()
        need((metadata.st_dev, metadata.st_ino) == self.file_identities[name]
             and metadata.st_nlink == 1 and stat.S_IMODE(metadata.st_mode) == 0o600, 'RESERVATION_CHANGED')
        pending = memoryview(data)
        while pending:
            written = os.write(self.files[name], pending)
            need(written > 0, 'PIPE_FAILURE')
            pending = pending[written:]

    def save(self, report):
        if self.output is None:
            return
        need(directory_identity(self.output) == self.output_identity, 'RESERVATION_CHANGED')
        fd = self.files['operator-result.json']
        metadata = (self.output / 'operator-result.json').lstat()
        need((metadata.st_dev, metadata.st_ino) == self.file_identities['operator-result.json']
             and metadata.st_nlink == 1 and stat.S_IMODE(metadata.st_mode) == 0o600, 'RESERVATION_CHANGED')
        data = json.dumps(report, sort_keys=True).encode()
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        self.private_write('operator-result.json', data)
        os.fsync(fd)

    def finish(self):
        if self.auth_process is not None:
            self.auth_close(self.auth_process)
        if self.process is not None:
            for stream in [self.process.stdin, self.process.stdout, self.process.stderr]:
                if stream is not None and not stream.closed:
                    stream.close()
        for fd in self.files.values():
            os.close(fd)
        self.files.clear()


def main():
    ports = None
    try:
        need(sys.flags.isolated and len(sys.argv) == 1
             and set(os.environ) <= {'PATH', 'TMPDIR', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'}
             and os.environ.get('PATH') == '/usr/bin:/bin', 'INPUT_REJECTED')
        bundle = load_fixed()
        ports = RealPorts()
        report = run_operator(bundle, ports)
    except (Exception, KeyboardInterrupt) as error:
        report = {'schema': 'SD-CLAUDE-OWNED-REVIEW-1', 'status': 'PRELAUNCH_REJECTED',
                  'firstFailure': error.code if isinstance(error, ReviewError) else 'INPUT_REJECTED',
                  'authChecks': 0, 'reviewStarts': 0, 'actualClaudeExtensionACK': False}
    finally:
        if ports is not None:
            try:
                ports.finish()
            except Exception:
                report['status'] = 'UNRESOLVED'
                report['firstFailure'] = report.get('firstFailure') or 'CLEANUP_UNRESOLVED'
    print(json.dumps(report, sort_keys=True))
    # Effective max is not proved by any currently admitted native schema.
    # Even useful model text requires independent acceptance, never exit-zero.
    return 1


if __name__ == '__main__':
    raise SystemExit(main())

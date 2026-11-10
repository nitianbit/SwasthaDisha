"""One fixed local configuration activation; never starts Ruflo or a model.

Not executable authority: two actual independent stage decisions are required
in the fixed private receipt. Import is inert; pure validation tests need no
private configuration. Failure after claim leaves partial state for review.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[3]
AREA = Path('/private/tmp/sd-local-ruflo-activation-0k4r5m8l')
PLAN = AREA / 'plan.json'
PLAN_SHA = '7e1a9e0a846e106ff3944922cbcae39f6b05e3dc5c07316ed12bd6f835da02da'
AUTHOR = '/root/local_claude_review_prep'
DECISION = 'APPROVE_ONE_LOCAL_RUFLO_ACTIVATION'
APPROVAL = AREA / 'approval.json'
CLI = Path('/Users/shubham/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude')
CLI_SHA = 'a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450'
SPEC = importlib.util.spec_from_file_location('fixed_local_smoke', ROOT / 'tools/agents/ruflo-extension-smoke.py')
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


def need(value, code):
    if not value:
        raise RuntimeError(code)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def private_regular(path):
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid()
         and stat.S_IMODE(s.st_mode) == 0o600, 'PRIVATE_REGULAR_INPUT_REQUIRED')
    return path.read_bytes(), (s.st_dev, s.st_ino)


def validate_approval(value, expected):
    need(isinstance(value, dict) and set(value) == set(expected) | {'reviewers'}
         and all(value[k] == v for k, v in expected.items()), 'EXACT_STAGE_APPROVAL_REQUIRED')
    reviewers = value['reviewers']
    need(isinstance(reviewers, list) and len(reviewers) == 2
         and all(isinstance(r, dict) and set(r) == {'agent', 'decision'}
             and r['decision'] == DECISION and isinstance(r['agent'], str)
             and re.fullmatch(r'/root(?:/[A-Za-z0-9_]+)*', r['agent'])
             and r['agent'] != AUTHOR for r in reviewers)
         and len({r['agent'] for r in reviewers}) == 2, 'TWO_ACTUAL_NONAUTHOR_STAGE_DECISIONS_REQUIRED')


def validate_candidate(before, candidate, expected_profile):
    """The complete byte delta is one args line in the existing Ruflo table."""
    text = before.decode()
    tables = list(re.finditer(r'^\[([^\]\n]+)\][ \t]*$', text, re.MULTILINE))
    selected = [i for i, match in enumerate(tables) if match.group(1) == 'mcp_servers.ruflo']
    need(len(selected) == 1, 'EXISTING_CODEX_TABLE_REQUIRED')
    index = selected[0]; start = tables[index].end(); end = tables[index + 1].start() if index + 1 < len(tables) else len(text)
    lines = list(re.finditer(r'^args[ \t]*=[^\n]*$', text[start:end], re.MULTILINE))
    need(len(lines) == 1, 'ONE_ORIGINAL_ARGS_LINE_REQUIRED')
    line = lines[0]
    replacement = 'args = ' + json.dumps(expected_profile['args'])
    reconstructed = (text[:start + line.start()] + replacement + text[start + line.end():]).encode()
    need(candidate == reconstructed, 'CODEX_CANDIDATE_CHANGES_UNRELATED_BYTES')
    old = tomllib.loads(before.decode()); new = tomllib.loads(candidate.decode())
    expected = copy.deepcopy(old); expected['mcp_servers']['ruflo']['args'] = expected_profile['args']
    need(new == expected and new['mcp_servers']['ruflo'] == expected_profile, 'CODEX_PROFILE_CANDIDATE_MISMATCH')


def validate_invocation(argv, isolated, environment):
    # macOS/Python adds these two locale metadata keys even after env -i. None
    # of the outer environment is forwarded to the registration command.
    need(len(argv) == 1 and isolated and set(environment) <= {
        'PATH', 'TMPDIR', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING'}
        and environment.get('TMPDIR') == '/private/tmp', 'FIXED_ISOLATED_INVOCATION_REQUIRED')


def main():
    validate_invocation(sys.argv, sys.flags.isolated, os.environ)
    area = AREA.lstat()
    need(stat.S_ISDIR(area.st_mode) and area.st_uid == os.getuid()
         and stat.S_IMODE(area.st_mode) == 0o700, 'PRIVATE_AREA_REQUIRED')
    area_key = (area.st_dev, area.st_ino)
    def owned():
        now = AREA.lstat()
        need(stat.S_ISDIR(now.st_mode) and (now.st_dev, now.st_ino) == area_key
             and now.st_uid == os.getuid() and stat.S_IMODE(now.st_mode) == 0o700, 'PRIVATE_AREA_CHANGED')
    plan_bytes, plan_key = private_regular(PLAN)
    need(sha(plan_bytes) == PLAN_SHA, 'FIXED_PLAN_CHANGED')
    plan = json.loads(plan_bytes)
    need(plan['schema'] == 'SD-LOCAL-RUFLO-ACTIVATION-1' and plan['privateDirectory'] == str(AREA)
         and plan['adapterSource'] == str(SMOKE.ROOT / 'tools/agents/ruflo-local.mjs')
         and plan['installedAdapter'] == str(SMOKE.INSTALLED) and plan['adapterSha256'] == SMOKE.ADAPTER_SHA
         and plan['cli'] == str(CLI) and plan['cliSha256'] == CLI_SHA, 'FIXED_PLAN_PATH_MISMATCH')
    program = SMOKE.regular(Path(__file__))
    expected = {'schema': 'SD-LOCAL-RUFLO-ACTIVATION-APPROVAL-1', 'decision': DECISION,
                'planSha': PLAN_SHA, 'programSha': sha(program), 'sourceRoot': str(ROOT),
                'smokeSha': sha(SMOKE.regular(ROOT / 'tools/agents/ruflo-extension-smoke.py'))}
    approval_bytes, approval_key = private_regular(APPROVAL)
    validate_approval(json.loads(approval_bytes), expected)
    SMOKE.preservation()
    SMOKE.no_live_state(SMOKE.STATE)
    for path in [SMOKE.STATE / 'extension-setup.lock', SMOKE.INSTALLED.parent, AREA / 'activation.claim.json', AREA / 'activation-result.json']:
        SMOKE.absent(path)
    for path, expected_sha in SMOKE.PINS.items():
        if path != SMOKE.INSTALLED:
            need(sha(SMOKE.regular(path)) == expected_sha, 'FIXED_RUNTIME_INPUT_CHANGED')
    need(sha(SMOKE.regular(CLI)) == CLI_SHA, 'FIXED_CLAUDE_CLI_CHANGED')
    adapter_data = SMOKE.regular(Path(plan['adapterSource']))
    need(sha(adapter_data) == SMOKE.ADAPTER_SHA, 'FROZEN_ADAPTER_SOURCE_CHANGED')
    candidate_path = AREA / 'codex.after.private'
    candidate, candidate_key = private_regular(candidate_path)
    need(sha(candidate) == plan['codexCandidateSha256'], 'CODEX_CANDIDATE_CHANGED')
    backups = {}; configs = {}; config_keys = {}; backup_keys = {}; descriptors = {}
    for name, fixed_path in [('codex', SMOKE.HOME / '.codex/config.toml'), ('claude', SMOKE.HOME / '.claude.json')]:
        snapshot = plan['snapshots'][name]
        need(snapshot['path'] == str(fixed_path) and snapshot['backup'] == str(AREA / (name + '.before.private')), 'FIXED_CONFIG_PATH_MISMATCH')
        backup, backup_key = private_regular(Path(snapshot['backup']))
        current, key = private_regular(fixed_path)
        need(key == (snapshot['dev'], snapshot['ino']) and current == backup
             and sha(current) == snapshot['sha256'], 'CONFIG_OR_BACKUP_SNAPSHOT_CHANGED')
        backups[name] = backup; configs[name] = fixed_path; config_keys[name] = key; backup_keys[name] = backup_key
    validate_candidate(backups['codex'], candidate, plan['codexExpectedPublicProfile'])
    before_claude = json.loads(backups['claude'])
    need(isinstance(before_claude, dict) and isinstance(before_claude.get('mcpServers', {}), dict)
         and 'ruflo' not in before_claude.get('mcpServers', {}), 'CLAUDE_SERVER_COLLISION')
    after_claude = copy.deepcopy(before_claude)
    after_claude.setdefault('mcpServers', {})['ruflo'] = plan['claudeExpectedProfile']
    fixed_argv = [str(CLI), 'mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'ruflo', '--', str(SMOKE.NODE), str(SMOKE.INSTALLED)]
    need(plan['claudeRegistrationArgv'] == fixed_argv, 'FIXED_CLI_COMMAND_CHANGED')
    # Validate both candidate public profiles before installation; only the
    # deliberately absent installed adapter is omitted from this preflight.
    SMOKE.admit(pins={p: h for p, h in SMOKE.PINS.items() if p != SMOKE.INSTALLED},
        node=SMOKE.NODE, adapter=SMOKE.INSTALLED, state=SMOKE.STATE, environment=SMOKE.ENV,
        codex=plan['codexExpectedPublicProfile'], claude=plan['claudeExpectedProfile'],
        package=json.loads(SMOKE.regular(SMOKE.CLI / 'package.json')))
    for name, config in configs.items():
        fd = os.open(config, (os.O_RDONLY if name == 'claude' else os.O_RDWR) | os.O_NOFOLLOW)
        # Claude is held read-only; CLI may atomically replace it once invoked.
        descriptors[name] = fd
        s = os.fstat(fd)
        need((s.st_dev, s.st_ino) == config_keys[name], 'HELD_CONFIG_IDENTITY_CHANGED')
    installed_key = None; added_directories = {}
    report = {'schema': 'SD-LOCAL-RUFLO-ACTIVATION-RESULT-1', 'status': 'CLAIMED_NOT_MUTATED',
        'planSha': PLAN_SHA, 'programSha': expected['programSha'], 'approvalSha': sha(approval_bytes),
        'stage': 'CLAIM', 'mutations': [], 'RufloProcessesStarted': 0, 'modelCalls': 0,
        'actual_claude_extension_acknowledged': False, 'client_reload': 'NOT_REQUESTED'}
    claim = report_file = None
    phase = 'before'
    def snapshots():
        owned()
        need(private_regular(PLAN) == (plan_bytes, plan_key)
             and private_regular(APPROVAL) == (approval_bytes, approval_key)
             and private_regular(candidate_path) == (candidate, candidate_key), 'PRIVATE_INPUT_CHANGED')
        for name in ('codex', 'claude'):
            need(private_regular(AREA / (name + '.before.private')) == (backups[name], backup_keys[name]), 'PRIVATE_BACKUP_CHANGED')
        expected_codex = backups['codex'] if phase == 'before' else candidate
        codex_bytes, codex_key = private_regular(configs['codex'])
        need(codex_bytes == expected_codex and codex_key == config_keys['codex'], 'CODEX_PHASE_SNAPSHOT_CHANGED')
        claude_bytes, claude_key = private_regular(configs['claude'])
        if phase != 'registered':
            need(claude_bytes == backups['claude'] and claude_key == config_keys['claude'], 'CLAUDE_PHASE_SNAPSHOT_CHANGED')
        else:
            need(json.loads(claude_bytes) == after_claude, 'CLAUDE_CHANGED_UNRELATED_STATE')
        SMOKE.no_live_state(SMOKE.STATE); SMOKE.absent(SMOKE.STATE / 'extension-setup.lock')
        for path, key in added_directories.items():
            SMOKE.directory(path); need(SMOKE.identity(path) == key, 'INSTALLED_DIRECTORY_CHANGED')
        for path, expected_sha in SMOKE.PINS.items():
            if path != SMOKE.INSTALLED:
                need(sha(SMOKE.regular(path)) == expected_sha, 'FIXED_RUNTIME_INPUT_CHANGED')
        need(sha(SMOKE.regular(CLI)) == CLI_SHA, 'FIXED_CLAUDE_CLI_CHANGED')
        if installed_key is not None:
            need(SMOKE.identity(SMOKE.INSTALLED) == installed_key
                 and sha(SMOKE.regular(SMOKE.INSTALLED)) == SMOKE.ADAPTER_SHA, 'INSTALLED_ADAPTER_CHANGED')
        else:
            SMOKE.absent(SMOKE.INSTALLED)
        SMOKE.preservation()
    def save():
        owned(); report_file.write(report)
    try:
        snapshots()
        claim = SMOKE.HeldFile(AREA / 'activation.claim.json')
        claim.write({'planSha': PLAN_SHA, 'programSha': expected['programSha'], 'approvalSha': report['approvalSha']})
        report_file = SMOKE.HeldFile(AREA / 'activation-result.json'); save()
        report['stage'] = 'INSTALL_ADAPTER'; save(); snapshots()
        parent = SMOKE.INSTALLED.parent.parent
        if not os.path.lexists(parent):
            parent.mkdir(mode=0o700); added_directories[parent] = SMOKE.identity(parent)
        else:
            SMOKE.directory(parent)
        snapshots(); SMOKE.INSTALLED.parent.mkdir(mode=0o700)
        added_directories[SMOKE.INSTALLED.parent] = SMOKE.identity(SMOKE.INSTALLED.parent)
        snapshots()
        fd = os.open(SMOKE.INSTALLED, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            installed_key = (os.fstat(fd).st_dev, os.fstat(fd).st_ino)
            with os.fdopen(os.dup(fd), 'wb') as output:
                output.write(adapter_data); output.flush(); os.fsync(output.fileno())
        finally:
            os.close(fd)
        report['mutations'].append('FROZEN_ADAPTER_INSTALLED'); snapshots(); save()
        report['stage'] = 'CODEX_ARGS'; save(); snapshots()
        fd = descriptors['codex']; current = os.fstat(fd)
        need((current.st_dev, current.st_ino) == config_keys['codex'], 'HELD_CONFIG_IDENTITY_CHANGED')
        os.lseek(fd, 0, os.SEEK_SET); os.ftruncate(fd, 0)
        pending = memoryview(candidate)
        while pending:
            written = os.write(fd, pending); need(written > 0, 'CODEX_WRITE_INCOMPLETE'); pending = pending[written:]
        os.fsync(fd); phase = 'codex-written'
        report['mutations'].append('CODEX_ONLY_ARGS_CHANGED'); snapshots(); save()
        report['stage'] = 'CLAUDE_REGISTRATION'; save(); snapshots()
        need(sha(SMOKE.regular(CLI)) == CLI_SHA and sha(SMOKE.regular(SMOKE.NODE)) == SMOKE.PINS[SMOKE.NODE], 'FIXED_CLI_INPUT_CHANGED')
        result = subprocess.run(fixed_argv, cwd=AREA, env={'HOME': str(SMOKE.HOME),
            'PATH': str(SMOKE.NODE.parent) + ':/usr/bin:/bin'}, capture_output=True, timeout=30)
        report['cli_result'] = {'exit': result.returncode, 'stdoutSha': sha(result.stdout), 'stderrSha': sha(result.stderr)}
        need(result.returncode == 0, 'REGISTRATION_OUTCOME_REQUIRES_REVIEW')
        phase = 'registered'; snapshots()
        report['mutations'].append('CLAUDE_ONLY_RUFLO_ADDED')
        SMOKE.read_fixed_inputs(); snapshots()
        report['stage'] = 'READBACK'; report['status'] = 'ACTIVATED_PENDING_SEPARATE_TRANSPORT_REVIEW'
        report['codexAfterSha'] = sha(private_regular(configs['codex'])[0])
        report['claudeAfterSha'] = sha(private_regular(configs['claude'])[0]); save()
    except Exception as error:
        report['status'] = 'UNRESOLVED_REVIEW_REQUIRED'
        report['failureType'] = type(error).__name__  # never config/result/error text
        try:
            if report_file is not None: save()
        except Exception:
            pass
    finally:
        for held in (claim, report_file):
            if held is not None: held.close()
        for fd in descriptors.values(): os.close(fd)
    print(json.dumps({'status': report['status'], 'stage': report['stage'], 'report': str(AREA / 'activation-result.json'),
        'RufloProcessesStarted': 0, 'modelCalls': 0, 'actual_claude_extension_acknowledged': False}))
    return 0 if report['status'] == 'ACTIVATED_PENDING_SEPARATE_TRANSPORT_REVIEW' else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({'status': 'PRELAUNCH_OR_UNRESOLVED_REVIEW_REQUIRED', 'modelCalls': 0,
                          'actual_claude_extension_acknowledged': False}))
        sys.exit(1)

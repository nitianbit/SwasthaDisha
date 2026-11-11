"""One fixed --help probe; only flag/count/hash metadata leaves memory."""
from pathlib import Path
import hashlib
import json
import os
import selectors
import subprocess
import time

CLI = '/Users/shubham/.vscode/extensions/anthropic.claude-code-2.1.322-darwin-arm64/resources/native-binary/claude'
PIN = 'a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450'
DEST = Path(__file__).with_name('help-metadata.json')
assert not DEST.exists()
assert hashlib.sha256(Path(CLI).read_bytes()).hexdigest() == PIN
started = time.monotonic()
p = subprocess.Popen([CLI, '--help'], stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    cwd='/private/tmp', env={'HOME': '/Users/shubham', 'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'})
out, err, first, signals = bytearray(), bytearray(), None, []
selector = selectors.DefaultSelector()
try:
    for stream in (p.stdout, p.stderr):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    while selector.get_map():
        if time.monotonic() - started > 15:
            first = 'METADATA_TIMEOUT'; break
        for key, _ in selector.select(0.1):
            chunk = os.read(key.fileobj.fileno(), 8192)
            if not chunk:
                selector.unregister(key.fileobj); continue
            buf, cap = (out, 128 * 1024) if key.fileobj is p.stdout else (err, 64 * 1024)
            if len(buf) + len(chunk) > cap:
                first = 'METADATA_OUTPUT_LIMIT'; break
            buf.extend(chunk)
        if first:
            break
    if not first:
        p.wait(timeout=2)
except BaseException:
    first = first or 'METADATA_CAPTURE_FAILED'
finally:
    selector.close()
    if p.poll() is None:
        p.terminate(); signals.append('HELD_POPEN_TERM')
        try:
            p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            p.kill(); signals.append('HELD_POPEN_KILL'); p.wait(timeout=2)
    for stream in (p.stdout, p.stderr):
        stream.close()
try:
    os.kill(p.pid, 0)
    absent = False
except ProcessLookupError:
    absent = True
except PermissionError:
    absent = None
group = subprocess.run(['/usr/bin/pgrep', '-g', str(p.pid)], capture_output=True,
    env={'PATH': '/usr/bin:/bin'}, timeout=2)
text = out.decode('utf-8', errors='replace')
flags = ['--print', '--model', '--effort', '--output-format', '--verbose', '--restricted',
    '--max-turns', '--tools', '--strict-mcp-config', '--mcp-config', '--allowedTools',
    '--disallowedTools', '--permission-mode', '--permission-prompts', '--no-chrome',
    '--no-session-persistence', '--disable-slash-commands', '--session-id']
effort_lines = [line for line in text.splitlines() if '--effort' in line]
enums = [value for value in ['low', 'medium', 'high', 'xhigh', 'max']
    if any('"' + value + '"' in line for line in effort_lines)]
result = {'schema': 'SD-CLAUDE-HELP-METADATA-1', 'clientSha256': PIN,
    'argv': ['--help'], 'modelRequests': 0, 'authStatusRequests': 0,
    'exitCode': p.returncode, 'firstFailure': first,
    'stdoutBytes': len(out), 'stdoutSha256': hashlib.sha256(out).hexdigest(),
    'stderrBytes': len(err), 'stderrSha256': hashlib.sha256(err).hexdigest(),
    'supportedFlagsInHelp': {flag: flag in text for flag in flags},
    'effortEnumsInHelp': enums, 'effectiveEffortProof': 'UNPROVEN',
    'managedPolicyProof': 'UNPROVEN', 'nativeStreamSchemaProof': 'UNPROVEN',
    'cleanup': {'heldPid': p.pid, 'pidAbsent': absent,
        'freshGroupEmpty': group.returncode == 1 and group.stdout == b'',
        'pipesClosed': p.stdout.closed and p.stderr.closed, 'signals': signals}}
DEST.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))

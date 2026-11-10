"""Prepared one-run operator. No runtime authority is supplied by this file."""

import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid


PACKET = pathlib.Path('/private/tmp/swasthadisha-parallel-p1qom53w/network-recipe/output/qa/batch3-network-recipe')
ROOT = pathlib.Path('/private/tmp/swasthadisha-parallel-p1qom53w/network-run-eba7e5c')
CANDIDATE = 'eba7e5c82e3ff63af9e9a958fbd100733e1fc439'
MANIFEST_SHA = '6d71e8c47f46bc941751515f15e0d3c802be6863d7192d61ad3966d6730dc804'
NODE = '/private/tmp/m0-node22/node'
NODE_SHA = '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0'
DOCKER = '/usr/local/bin/docker'
ENDPOINT = 'unix:///Users/shubham/.docker/run/docker.sock'
ENGINE = '16ab25f6-88c7-4687-a431-b119b6ab9319'
IMAGE = 'node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d'
APPROVAL = pathlib.Path('/private/tmp/swasthadisha-parallel-p1qom53w/network-approval-eba7e5c.json')
DECISION = 'APPROVE_ONE_FIXED_NO_DB_RUN'
SCOPE = 'ONE_FIXED_NO_DB_RUN_NO_RETRY_NO_PULL_NO_DAEMON_START'
AUTHOR = '/root/batch2_network_check'
OPERATIONS = {'payments': 'create-order', 'sms': 'send', 'email': 'send', 'push': 'send',
              'calendar': 'create-event', 'storage': 'put', 'queue': 'enqueue'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def regular_bytes(path):
    metadata = path.lstat()
    require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'Non-regular or linked input: ' + str(path))
    return path.read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def utc():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def git(*arguments):
    result = subprocess.run(['/usr/bin/git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *arguments],
                            cwd=ROOT, env={'PATH': '/usr/bin:/bin'}, capture_output=True, timeout=25, check=True)
    return result.stdout


def validate_packet_and_approval():
    require(len(sys.argv) == 1 and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
            'Use the exact isolated Python invocation, without positional inputs')
    require(pathlib.Path(__file__).absolute() == PACKET / 'operator.py', 'Unexpected operator location')
    operator_sha = digest(regular_bytes(PACKET / 'operator.py'))
    manifest_bytes = regular_bytes(PACKET / 'source-manifest.json')
    require(digest(manifest_bytes) == MANIFEST_SHA, 'Unreviewed source manifest')
    manifest = json.loads(manifest_bytes)
    require(manifest['schema'] == 'SD-NET-RUN-SOURCES-1'
            and manifest['candidate_commit'] == CANDIDATE and manifest['candidate_root'] == str(ROOT)
            and manifest['endpoint'] == ENDPOINT and manifest['engine_id'] == ENGINE and manifest['image'] == IMAGE
            and manifest['host_node'] == {'path': NODE, 'version': 'v22.23.4', 'sha256': NODE_SHA},
            'Source manifest changed fixed inputs')
    review_bytes = regular_bytes(PACKET / 'review-input.json')
    packet_files = json.loads(review_bytes)['files']
    require(set(packet_files) == {'operator.py', 'source-manifest.json', 'CONTRACT.md', 'PRIMARY_SOURCE_VALIDATION.md'},
            'Unexpected review packet')
    for name, expected in packet_files.items():
        require(digest(regular_bytes(PACKET / name)) == expected, 'Changed review packet: ' + name)
    receipt_stat = APPROVAL.lstat()
    require(stat.S_ISREG(receipt_stat.st_mode) and receipt_stat.st_nlink == 1
            and receipt_stat.st_uid == os.getuid() and not receipt_stat.st_mode & 0o022,
            'Approval must be an owned regular file without group/world write')
    receipt_bytes = regular_bytes(APPROVAL)
    receipt = json.loads(receipt_bytes)
    expected = {'schema': 'SD-NETWORK-RUN-APPROVAL-1', 'decision': DECISION, 'scope': SCOPE,
                'candidate_commit': CANDIDATE, 'candidate_root': str(ROOT), 'operator_sha256': operator_sha,
                'source_manifest_sha256': MANIFEST_SHA, 'review_input_sha256': digest(review_bytes)}
    require(set(receipt) == set(expected) | {'reviewers'}
            and all(receipt[key] == value for key, value in expected.items()), 'Approval does not bind this exact run')
    reviewers = receipt['reviewers']
    require(isinstance(reviewers, list) and len(reviewers) == 2, 'Two actual nonauthor run reviews required')
    for reviewer in reviewers:
        require(isinstance(reviewer, dict) and set(reviewer) == {'agent', 'decision'}
                and isinstance(reviewer['agent'], str) and re.fullmatch(r'/root/[A-Za-z0-9_/]+', reviewer['agent'])
                and reviewer['agent'] != AUTHOR and reviewer['decision'] == DECISION, 'Invalid run-review record')
    require(len({row['agent'] for row in reviewers}) == 2, 'Reviewers must be distinct nonauthors')
    claim = pathlib.Path('/private/tmp/sd-network-run-eba7e5c-' + operator_sha + '.claim.json')
    require(not os.path.lexists(claim), 'This exact operator attempt was already claimed; review required')
    return manifest, operator_sha, digest(receipt_bytes), claim


def validate_network_summary(summary):
    require(isinstance(summary, dict) and set(summary) == {'tag', 'observation', 'loopback', 'controlFiles',
            'downDevices', 'loopbackAddresses'} and summary['tag'] == 'APP-NET-ADMIT-1'
            and summary['loopback'] == 'lo', 'Malformed network summary')
    observation = summary['observation']
    require(isinstance(observation, dict) and set(observation) == {'tag', 'entries', 'addressedInterfaces'}
            and observation['tag'] == 'APP-NET-DIAG-1', 'Malformed network observation')
    entries = observation['entries']
    require(isinstance(entries, list) and 1 <= len(entries) <= 16, 'Invalid interface count')
    names, controls, down, loopbacks = [], [], [], 0
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {'name', 'kind', 'flags', 'operstate', 'type'},
                'Malformed interface record')
        name = entry['name']
        require(isinstance(name, str) and re.fullmatch(r'(?!\.{1,2}$)[A-Za-z0-9_.-]{1,32}', name), 'Invalid interface name')
        names.append(name)
        if name != 'lo' and entry['kind'] == 'file':
            require(all(entry[field] == {'unavailable': 'ENOTDIR'} for field in ['flags', 'operstate', 'type']),
                    'Invalid control-file exemption')
            controls.append(name)
            continue
        require(entry['kind'] == 'symlink' and isinstance(entry['flags'], str)
                and re.fullmatch(r'0x(0|[1-9a-f][0-9a-f]{0,7})', entry['flags'])
                and isinstance(entry['type'], str) and re.fullmatch(r'(0|[1-9][0-9]{0,4})', entry['type']),
                'Invalid device metadata')
        flags, kind = int(entry['flags'], 16), int(entry['type'])
        require(kind <= 65535 and not flags & (0x40 | 0x10000 | 0x20000), 'Unexpected device bits/type')
        if name == 'lo':
            require(flags & 9 == 9 and kind == 772 and entry['operstate'] in ['unknown', 'up'], 'Loopback rejected')
            loopbacks += 1
        else:
            require(not flags & 9 and kind != 772 and entry['operstate'] == 'down', 'Non-loopback device rejected')
            down.append(name)
    require(names == sorted(set(names)) and loopbacks == 1, 'Interface order or loopback count rejected')
    addressed = observation['addressedInterfaces']
    require(isinstance(addressed, list) and len(addressed) == 1 and isinstance(addressed[0], dict)
            and set(addressed[0]) == {'name', 'addresses'} and addressed[0]['name'] == 'lo', 'Addressed interfaces rejected')
    addresses = addressed[0]['addresses']
    require(isinstance(addresses, list) and 1 <= len(addresses) <= 2, 'Loopback addresses rejected')
    allowed = {'127.0.0.1': 'IPv4', '::1': 'IPv6'}
    for row in addresses:
        require(isinstance(row, dict) and set(row) == {'address', 'family', 'internal'}
                and isinstance(row['address'], str) and row['address'] in allowed
                and row['family'] == allowed[row['address']] and row['internal'] is True, 'Loopback address rejected')
    values = sorted(row['address'] for row in addresses)
    require(len(set(values)) == len(values) and '127.0.0.1' in values, 'Duplicate/missing loopback address')
    require(summary['controlFiles'] == controls and summary['downDevices'] == down
            and summary['loopbackAddresses'] == values, 'Network summary does not match its observation')


def main(preflight, report):
    # No allocation, Node or Docker/socket access precedes exact packet/run-approval validation.
    manifest, operator_sha, approval_sha, claim = preflight
    area = pathlib.Path(tempfile.mkdtemp(prefix='sd-network-admission-run-', dir='/private/tmp'))
    identity = area.lstat()
    run_id = str(uuid.uuid4())
    marker = area / '.operator-owner.json'
    marker.write_text(json.dumps({'runId': run_id, 'candidate': CANDIDATE}) + '\n')
    marker.chmod(0o600)
    config = area / 'docker'
    config.mkdir(mode=0o700)
    (config / 'config.json').write_text('{"auths":{}}\n')
    (config / 'config.json').chmod(0o600)
    config_identity = config.lstat()
    report.update({'status': 'IN_PROGRESS', 'candidate': CANDIDATE, 'operator_sha256': operator_sha,
                   'source_manifest_sha256': MANIFEST_SHA, 'approval_sha256': approval_sha, 'operator_run_id': run_id,
                   'operator_directory': str(area), 'started_at': utc(),
                   'commands': [], 'resources': {}, 'scope': SCOPE})

    def owned():
        current, configuration = area.lstat(), config.lstat()
        require(stat.S_ISDIR(current.st_mode) and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino)
                and stat.S_ISDIR(configuration.st_mode)
                and (configuration.st_dev, configuration.st_ino) == (config_identity.st_dev, config_identity.st_ino),
                'Operator workspace identity changed')
        require(json.loads(regular_bytes(marker)) == {'runId': run_id, 'candidate': CANDIDATE}
                and regular_bytes(config / 'config.json') == b'{"auths":{}}\n', 'Operator ownership/config changed')

    def save():
        owned()
        (area / 'operator-result.json').write_text(json.dumps(report, indent=2) + '\n')

    def freeze(label):
        require(ROOT.resolve() == ROOT and git('rev-parse', 'HEAD').decode().strip() == CANDIDATE
                and git('branch', '--show-current').strip() == b''
                and git('status', '--porcelain', '--untracked-files=all') == b'', 'Candidate is not clean/detached/fixed')
        for relative, expected in manifest['files'].items():
            path = pathlib.PurePosixPath(relative)
            require(not path.is_absolute() and '..' not in path.parts, 'Invalid source path')
            data = regular_bytes(ROOT / relative)
            require(digest(data) == expected and git('show', CANDIDATE + ':' + relative) == data,
                    'Candidate source changed: ' + relative)
        snapshot = {'candidate': CANDIDATE, 'clean_detached': True, 'source_manifest_sha256': MANIFEST_SHA,
                    'verified_file_count': len(manifest['files'])}
        (area / (label + '.json')).write_text(json.dumps(snapshot, indent=2) + '\n')
        return snapshot

    def docker(step, arguments):
        owned()
        with (area / (step + '.stdout.txt')).open('w') as out, (area / (step + '.stderr.txt')).open('w') as err:
            result = subprocess.run([DOCKER, '--config', str(config), '--host', ENDPOINT, *arguments],
                                    env={'PATH': '/usr/local/bin:/usr/bin:/bin'}, cwd=area,
                                    stdout=out, stderr=err, timeout=25)
        report['commands'].append({'step': step, 'arguments': arguments, 'exit_code': result.returncode})
        save()
        return result.returncode, (area / (step + '.stdout.txt')).read_text(), (area / (step + '.stderr.txt')).read_text()

    def engine(step):
        code, out, _ = docker(step, ['info', '--format', '[{{json .ID}},{{json .OSType}}]'])
        require(code == 0 and json.loads(out) == [ENGINE, 'linux'], 'Recorded engine unavailable or changed')

    def zero_labels(step):
        code, out, _ = docker(step, ['ps', '--all', '--filter', 'label=swasthadisha.test.purpose=app-isolation', '--quiet', '--no-trunc'])
        report[step + '_count'] = len(out.split())
        require(code == 0 and not out.split(), 'Existing purpose-labelled resources; do not adopt/remove')

    save()
    print(json.dumps({'operator_directory': str(area), 'phase': 'preflight'}), flush=True)
    try:
        report['source_before_image'] = freeze('source-before-image')
        require(digest(regular_bytes(pathlib.Path(NODE))) == NODE_SHA, 'Host Node bytes changed')
        version = subprocess.run([NODE, '--version'], env={}, capture_output=True, text=True, timeout=10, check=True)
        require(version.stdout.strip() == 'v22.23.4' and not version.stderr, 'Host Node version changed')
        socket = pathlib.Path('/Users/shubham/.docker/run/docker.sock')
        require(stat.S_ISSOCK(socket.resolve().stat().st_mode), 'Recorded Docker socket unavailable')
        engine('engine-before-image')
        zero_labels('labels-before-image')
        code, out, _ = docker('cached-image', ['image', 'inspect', IMAGE])
        require(code == 0, 'Pinned image is not cached; do not pull')
        images = json.loads(out)
        require(isinstance(images, list) and len(images) == 1, 'Ambiguous cached image')
        image = images[0]
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', image['Id']) and IMAGE in image['RepoDigests']
                and image['Os'] == 'linux' and image['Architecture'] in ['amd64', 'arm64']
                and not image['Config'].get('Volumes'), 'Cached image metadata mismatch')
        entries = [entry.split('=', 1) for entry in image['Config']['Env']]
        require(all(len(row) == 2 for row in entries) and len({row[0] for row in entries}) == len(entries)
                and {'PATH', 'NODE_VERSION'}.issubset(row[0] for row in entries)
                and all((key == 'PATH' and value == '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
                        or (key == 'NODE_VERSION' and value == '22.23.4')
                        or (key == 'YARN_VERSION' and re.fullmatch(r'[0-9.]+', value)) for key, value in entries),
                'Cached image environment mismatch')
        report['cached_image'] = {key: image[key] for key in ['Id', 'RepoDigests', 'Os', 'Architecture']}
        report['source_before_launch'] = freeze('source-before-launch')
        require(digest(regular_bytes(pathlib.Path(NODE))) == NODE_SHA, 'Host Node changed before launch')
        engine('engine-before-launch')
        zero_labels('labels-before-create')
        owned()
        # Exclusive persistent claim prevents a second launcher attempt by this exact reviewed operator.
        with claim.open('x') as stream:
            report['attempt_claimed'] = True
            os.chmod(claim, 0o600)
            json.dump({'operator_sha256': operator_sha, 'candidate': CANDIDATE, 'approval_sha256': approval_sha,
                       'operator_directory': str(area), 'claimed_at': utc()}, stream)
        report['attempt_claim'] = str(claim)
        save()
        with (area / 'launcher.stdout.txt').open('w') as out, (area / 'launcher.stderr.txt').open('w') as err:
            # Both stream opens succeeded. Process creation/completion is uncertain until run returns.
            report['launcher_invocations'] = 'UNKNOWN'
            launch = subprocess.run([NODE, 'test/application/run.mjs', ENDPOINT], cwd=ROOT,
                                    env={'TMPDIR': '/private/tmp'}, stdout=out, stderr=err, timeout=300)
            report['launcher_invocations'] = 1
        report['launcher_exit_code'] = launch.returncode
        stdout, stderr = (area / 'launcher.stdout.txt').read_text(), (area / 'launcher.stderr.txt').read_text()
        records = []
        for line in stderr.splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict) and row.get('phase') == 'created':
                records.append(row)
        require(len(records) == 1 and set(records[0]) == {'phase', 'id', 'runId', 'directory'},
                'Missing or ambiguous create acknowledgement; no recovery adoption')
        resource = records[0]
        require(isinstance(resource['id'], str) and re.fullmatch(r'[a-f0-9]{64}', resource['id'])
                and isinstance(resource['runId'], str) and re.fullmatch(r'[a-f0-9-]{36}', resource['runId'])
                and isinstance(resource['directory'], str)
                and re.fullmatch(r'/private/tmp/sd-app-isolation-[A-Za-z0-9_-]+', resource['directory']),
                'Invalid exact-resource acknowledgement')
        report['resources'] = {key: resource[key] for key in ['id', 'runId', 'directory']}
        save()
        engine('engine-after-launch')
        code, _, error = docker('exact-container-after-launch', ['container', 'inspect', resource['id']])
        report['independent_container_absent'] = bool(code != 0 and resource['id'] in error
                                                     and re.search(r'No such (?:object|container)', error))
        report['independent_workspace_absent'] = not os.path.lexists(resource['directory'])
        zero_labels('labels-after-launch')
        report['source_after_launch'] = freeze('source-after-launch')
        cleanup = report['independent_container_absent'] and report['independent_workspace_absent']
        if launch.returncode != 0:
            report['status'] = 'FAIL' if cleanup else 'UNRESOLVED'
            report['review_required_before_retry'] = True
        else:
            result = json.loads(stdout)
            require(result['runId'] == resource['runId'] and result['containerId'] == resource['id']
                    and result['directory'] == resource['directory'] and result['image'] == IMAGE
                    and result['role'] == 'synthetic-ports-only' and result['cleanupAcknowledged'] is True
                    and result['admissionPassed'] is True and result['egressBlocked'] is True
                    and result['filesystemCanariesPassed'] is True and result['databaseMode'] == 'not-admitted'
                    and 'networkInterfaces' not in result and re.fullmatch(r'[a-f0-9]{64}', result['manifestSha']),
                    'Launcher success evidence mismatch')
            validate_network_summary(result['networkAdmission'])
            require(result['scenario'] == {'literalSearchPassed': True, 'unknownOperationRejected': True},
                    'Required scenario assertions missing')
            calls = result['calls']
            require(isinstance(calls, list) and len(calls) == 7 and {row['port'] for row in calls} == set(OPERATIONS)
                    and all(set(row) == {'port', 'operation', 'status', 'effect'}
                            and row['operation'] == OPERATIONS[row['port']] and row['status'] == 'recorded'
                            and row['effect'] is False for row in calls), 'Recording-port evidence mismatch')
            require(cleanup, 'Independent exact cleanup proof missing')
            report['status'], report['result'] = 'PASS', result
    except BaseException as error:
        uncertain = report['attempt_claimed'] or report['launcher_invocations'] != 0
        report['status'] = 'UNRESOLVED' if uncertain else 'BLOCKED_BEFORE_LAUNCH'
        report['operator_error'] = {'type': type(error).__name__, 'message': str(error)}
        report['review_required_before_retry'] = uncertain
        if report['launcher_invocations'] == 'UNKNOWN':
            report['process_completion_uncertain'] = True
            report['streams_may_be_incomplete'] = True
    finally:
        report['finished_at'] = utc()
        save()
        print(json.dumps({'operator_directory': str(area), 'status': report['status'],
                          'attempt_claimed': report['attempt_claimed'],
                          'launcher_invocations': report['launcher_invocations'], 'resources': report['resources'],
                          'operator_error': report.get('operator_error')}), flush=True)
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    try:
        prepared = validate_packet_and_approval()
    except Exception as error:
        # This checkpoint precedes allocation, Node and Docker/socket access.
        print(json.dumps({'status': 'BLOCKED_BEFORE_LAUNCH', 'attempt_claimed': False, 'launcher_invocations': 0,
                          'operator_error': {'type': type(error).__name__, 'message': str(error)}}), flush=True)
        sys.exit(1)
    execution = {'attempt_claimed': False, 'launcher_invocations': 0}
    try:
        exit_code = main(prepared, execution)
    except BaseException as error:
        # Preserve known claim/launch state even if recording the inner report failed.
        uncertain = execution['attempt_claimed'] or execution['launcher_invocations'] != 0
        print(json.dumps({'status': 'UNRESOLVED' if uncertain else 'BLOCKED_BEFORE_LAUNCH',
                          'attempt_claimed': execution['attempt_claimed'],
                          'launcher_invocations': execution['launcher_invocations'],
                          'operator_directory': execution.get('operator_directory'),
                          'review_required_before_retry': uncertain,
                          'operator_error': {'type': type(error).__name__, 'message': str(error)}}), flush=True)
        exit_code = 1
    sys.exit(exit_code)

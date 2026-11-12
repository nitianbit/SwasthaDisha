"""Fixed Node22 acquisition operator. Default invocation has no effects."""
import contextlib
import gzip
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import signal
import ssl
import stat
import sys
import tarfile
import time

QA = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab/output/qa/pharmacy-node22-recovery/revision-1')
PYTHON = Path('/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/bin/python3.14')
PYTHON_SHA = '87d4df53fd91304be5bac391fb204643c36b7df2023c04a0953bcbc7d4fdf634'
RECIPE_SHA = '48357c414d86b10f8aefc5419d6abcd429c92598c6dce59119c76c3a7d03c36a'
ARCHIVE_SHA = 'c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428'
BINARY_SHA = '2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0'
RELEASE = '/download/release/v22.23.4/'
ARCHIVE = 'node-v22.23.4-darwin-arm64.tar.gz'
MEMBER = 'node-v22.23.4-darwin-arm64/bin/node'
COMPRESSED_CAP, EXPANDED_CAP, MEMBER_CAP = 67108864, 1073741824, 268435456
BUFFER = 65536

class Refusal(Exception):
    pass

def need(condition, message):
    if not condition:
        raise Refusal(message)

def identity(info):
    return info.st_dev, info.st_ino, info.st_uid

def regular(info):
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid(), 'regular owned independent file required')

def chain(path):
    for item in [path, *path.parents]:
        need(stat.S_ISDIR(item.lstat().st_mode), 'directory symlink or wrong type')

def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while data := os.read(fd, BUFFER):
        digest.update(data)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()

def write_all(fd, data):
    while data:
        amount = os.write(fd, data)
        need(amount > 0, 'short write')
        data = data[amount:]

def json_bytes(value):
    return (json.dumps(value, indent=2) + '\n').encode()

@contextlib.contextmanager
def deadline(seconds):
    """SIGALRM also interrupts blocking DNS/TLS/read and decompression calls."""
    start = time.monotonic()
    old_handler = signal.getsignal(signal.SIGALRM)
    old_remaining, old_interval = signal.getitimer(signal.ITIMER_REAL)
    def expired(*_):
        raise Refusal('deadline exceeded')
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, min(seconds, old_remaining) if old_remaining else seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_handler)
        if old_remaining:
            signal.setitimer(signal.ITIMER_REAL, max(0.000001, old_remaining - (time.monotonic() - start)), old_interval)

class OwnedDirectory:
    """Private fd/inode ownership; persisted markers never authorize cleanup."""
    def __init__(self, parent, name, allowed):
        chain(parent)
        self.path, self.allowed, self.files = parent/name, frozenset(allowed), {}
        self.parent, self.name, self.fd, self.owned, self.created = parent, name, None, None, False
    def allocate(self):
        parent, name = self.parent, self.name
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)  # EEXIST rejects every existing object.
            self.created = True
            self.fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            self.owned = identity(os.fstat(self.fd))
            self.check()
        finally:
            os.close(parent_fd)
    def check(self):
        need(self.fd is not None and self.owned is not None, 'directory identity unavailable')
        need(identity(os.fstat(self.fd)) == self.owned, 'held directory changed')
        info = self.path.lstat()
        need(stat.S_ISDIR(info.st_mode) and identity(info) == self.owned, 'directory ownership drift')
    def create(self, name):
        self.check()
        need(name in self.allowed and name not in self.files, 'unapproved owned filename')
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        self.files[name] = (fd, identity(os.fstat(fd)))
        self.file(name)
        return fd
    def file(self, name):
        self.check()
        fd, expected = self.files[name]
        held = os.fstat(fd)
        regular(held)
        actual = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
        regular(actual)
        need(identity(held) == identity(actual) == expected, 'file ownership drift')
        return fd
    def record(self, name, value):
        fd = self.create(name)
        write_all(fd, json_bytes(value))
        os.fsync(fd)
        self.file(name)
    def describe(self):
        self.check()
        return {'path':str(self.path), 'directoryIdentity':list(self.owned), 'files':{name:{'identity':list(key), 'bytes':os.fstat(self.file(name)).st_size} for name, (_, key) in self.files.items()}}
    def remove(self):
        if not self.created:
            return
        self.check()
        for name in list(self.files):
            self.file(name)
            os.unlink(name, dir_fd=self.fd)
            fd, _ = self.files.pop(name)
            os.close(fd)
        self.check()
        os.rmdir(self.path)  # Never recursive; an unexpected file blocks rmdir.
        try:
            self.path.lstat()
        except FileNotFoundError:
            return
        raise Refusal('removed path reappeared')
    def close(self):
        for fd, _ in self.files.values():
            os.close(fd)
        self.files.clear()
        if self.fd is not None:
            os.close(self.fd)

def download(path, cap, fd, factory):
    need(path in (RELEASE+'SHASUMS256.txt', RELEASE+ARCHIVE) and callable(factory), 'fixed download only')
    connection = factory()
    try:
        connection.connect()
        connection.sock.settimeout(5)
        connection.request('GET', path, headers={'Accept-Encoding':'identity', 'User-Agent':'SwasthaDisha-fixed-tool-recovery/1'})
        response = connection.getresponse()
        need(response.status == 200, 'HTTP status refused; no redirect/retry')
        headers = response.getheaders()
        values = lambda key: [value.strip() for name, value in headers if name.lower() == key]
        length, encoding, transfer = values('content-length'), values('content-encoding'), values('transfer-encoding')
        need(len(length) <= 1 and len(encoding) <= 1 and (not encoding or encoding == ['identity']), 'response framing/encoding refused')
        need(not transfer or transfer == ['chunked'], 'transfer encoding refused')
        need(not (length and transfer), 'conflicting transfer length')
        expected = None
        if length:
            need(length[0].isascii() and length[0].isdigit(), 'invalid response length')
            expected = int(length[0])
            need(0 < expected <= cap, 'response length cap')
        total, digest = 0, hashlib.sha256()
        while data := response.read(BUFFER):
            need(len(data) <= BUFFER, 'oversized read')
            total += len(data)
            need(total <= cap, 'response body cap')
            digest.update(data)
            write_all(fd, data)
        need(total > 0 and (expected is None or total == expected), 'response length mismatch')
        os.fsync(fd)
        return {'bytes':total, 'sha256':digest.hexdigest()}
    finally:
        connection.close()

def validate_metadata(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    data = os.read(fd, 65537)
    need(len(data) <= 65536, 'metadata cap')
    rows = []
    for line in data.decode('ascii').splitlines():
        fields = line.split()
        if fields and fields[-1] == ARCHIVE:
            rows.append(fields)
    need(rows == [[ARCHIVE_SHA, ARCHIVE]], 'exact unique published checksum required')

class ExpandedReader:
    def __init__(self, stream, cap):
        self.stream, self.cap, self.count = stream, cap, 0
    def read(self, size=BUFFER):
        need(size >= 0, 'unbounded decompression read')
        data = self.stream.read(min(size, BUFFER))
        self.count += len(data)
        need(self.count <= self.cap, 'decompression cap')
        return data

def unpack(archive_fd, output_fd, expected_archive=ARCHIVE_SHA, expected_binary=BINARY_SHA, expanded_cap=EXPANDED_CAP):
    need(digest_fd(archive_fd) == expected_archive, 'archive hash mismatch')
    found, count, size = False, 0, 0
    with os.fdopen(os.dup(archive_fd), 'rb') as raw, gzip.GzipFile(fileobj=raw) as zipped:
        expanded = ExpandedReader(zipped, expanded_cap)
        with tarfile.open(fileobj=expanded, mode='r|') as archive:
            for member in archive:
                count += 1
                need(count <= 65536, 'member count cap')
                if member.name != MEMBER:
                    continue  # No output paths, links or permissions materialized.
                need(not found, 'duplicate selected member')
                found = True
                need(member.isreg() and not member.issparse() and not member.linkname and 0 < member.size <= MEMBER_CAP, 'selected member must be bounded regular data')
                source = archive.extractfile(member)
                need(source is not None, 'member bytes missing')
                with source:
                    while data := source.read(BUFFER):
                        size += len(data)
                        need(size <= member.size and size <= MEMBER_CAP, 'member body cap')
                        write_all(output_fd, data)
                need(size == member.size, 'short selected member')
        while expanded.read(BUFFER):
            pass  # Reach gzip EOF/CRC and count all padding/decompressed bytes.
    need(found and digest_fd(output_fd) == expected_binary, 'selected member missing/hash mismatch')
    os.fsync(output_fd)
    return {'bytes':size, 'sha256':expected_binary, 'tarMembers':count, 'decompressedBytes':expanded.count}

def recover(parent, factory, provenance=None):
    """Live caller fixes parent/factory. Offline checks supply owned temp/fake HTTP."""
    stage = canonical = None
    first = None
    record = {'status':'FAILED', 'NodeExecutions':0, 'packageExecutions':0, 'attempts':1, 'cleanupExceptions':[]}
    record.update(provenance or {})
    record['officialUrls'] = {'metadata':'https://nodejs.org'+RELEASE+'SHASUMS256.txt', 'archive':'https://nodejs.org'+RELEASE+ARCHIVE}
    try:
        # Refuse canonical before allocating a stage; lstat sees dangling symlinks too.
        need(not os.path.lexists(parent/'m0-node22'), 'canonical destination exists')
        with deadline(300):
            stage = OwnedDirectory(parent, 'sd-pharmacy-node22-stage-'+secrets.token_hex(16), ['SHASUMS256.txt','archive.tar.gz','node.part','outcome.json'])
            stage.allocate()
            canonical = OwnedDirectory(parent, 'm0-node22', ['node','.owner.json','acquisition.json'])
            canonical.allocate()
            metadata = stage.create('SHASUMS256.txt')
            with deadline(30):
                record['metadata'] = download(RELEASE+'SHASUMS256.txt', 65536, metadata, factory)
            stage.file('SHASUMS256.txt')
            validate_metadata(metadata)
            archive = stage.create('archive.tar.gz')
            with deadline(180):
                record['archive'] = download(RELEASE+ARCHIVE, COMPRESSED_CAP, archive, factory)
            stage.file('archive.tar.gz')
            need(record['archive']['sha256'] == ARCHIVE_SHA, 'archive hash mismatch')
            node = stage.create('node.part')
            with deadline(60):
                record['binary'] = unpack(archive, node, ARCHIVE_SHA, BINARY_SHA)
            stage.file('node.part')
            published = canonical.create('node')
            os.lseek(node, 0, os.SEEK_SET)
            while data := os.read(node, BUFFER):
                write_all(published, data)
            os.fsync(published)
            canonical.file('node')
            need(os.fstat(published).st_size == record['binary']['bytes'] and digest_fd(published) == BINARY_SHA, 'published bytes mismatch')
            os.fchmod(published, 0o500)
            canonical.file('node')
            record.update(status='TOOL_BYTES_RECOVERED_NOT_EXECUTED', toolPath=str(canonical.path/'node'), toolIdentity=list(identity(os.fstat(published))), toolMode='0500')
            canonical.record('.owner.json', {'runId':secrets.token_hex(16), 'directoryIdentity':list(canonical.owned), 'markerIsCleanupAuthority':False})
            canonical.record('acquisition.json', record)
            record['retainedCanonical'] = canonical.describe()
            stage.record('outcome.json', record)
    except BaseException as error:
        first = error
        record.update(status='FAILED', firstFailure={'type':type(error).__name__, 'message':str(error)[:512]})
    # Cleanup cannot replace the first failure, including a cleanup deadline.
    try:
        with deadline(10):
            for owned in [stage, canonical if first is not None else None]:
                if owned is not None:
                    try:
                        owned.remove()
                    except BaseException as error:
                        record['cleanupExceptions'].append({'path':str(owned.path), 'type':type(error).__name__, 'message':str(error)[:512]})
    except BaseException as error:
        record['cleanupExceptions'].append({'type':type(error).__name__, 'message':str(error)[:512]})
    finally:
        for owned in [stage, canonical]:
            if owned is not None:
                try:
                    owned.close()
                except BaseException as error:
                    record['cleanupExceptions'].append({'type':type(error).__name__, 'message':str(error)[:512]})
    record['stageRemoved'] = stage is None or not os.path.lexists(stage.path)
    return record

def read_regular(path, cap=32768):
    chain(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        regular(os.fstat(fd))
        need(os.fstat(fd).st_size <= cap, 'input size cap')
        data = os.read(fd, cap+1)
        need(len(data) <= cap, 'input grew beyond cap')
        return data
    finally:
        os.close(fd)

def admit():
    need(sys.argv == [str(QA/'recover-node22.py'), '--acquire-once'], 'fixed live invocation required')
    need(Path(sys.executable) == PYTHON and sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode, 'pinned isolated Python required')
    need(os.uname().sysname == 'Darwin' and os.uname().machine == 'arm64', 'darwin arm64 required')
    need(set(os.environ) <= {'PATH','LC_ALL','LC_CTYPE'}, 'ambient override refused')
    need(hashlib.sha256(read_regular(PYTHON, 134217728)).hexdigest() == PYTHON_SHA, 'Python bytes changed')
    source = hashlib.sha256(read_regular(QA/'recover-node22.py')).hexdigest()
    launcher = hashlib.sha256(read_regular(QA/'LIVE_LAUNCHER.txt')).hexdigest()
    need(hashlib.sha256(read_regular(QA/'freeze.json')).hexdigest() == RECIPE_SHA, 'recipe freeze drift')
    freeze = json.loads(read_regular(QA/'freeze.json'))
    for name, digest in freeze['files'].items():
        need(name in ['RECIPE.md','SCRIPT_PLAN.md','PRIMARY_METADATA.json'], 'unexpected recipe input')
        need(hashlib.sha256(read_regular(QA/name)).hexdigest() == digest, 'recipe input drift')
    data = json.loads(read_regular(QA/'LIVE_ADMISSION.json'))
    need(set(data) == {'schema','sourceSha256','launcherSha256','recipeFreezeSha256','pythonSha256','reviews'}, 'closed live admission required')
    need(data['schema'] == 'SD-NODE22-ONE-ACQUISITION-1' and data['sourceSha256'] == source and data['launcherSha256'] == launcher and data['recipeFreezeSha256'] == RECIPE_SHA and data['pythonSha256'] == PYTHON_SHA, 'exact source/launcher admission required')
    reviews = data['reviews']
    need(isinstance(reviews, list) and len(reviews) == 2 and {item['role'] for item in reviews} == {'Spec','Standards'} and len({item['reviewer'] for item in reviews}) == 2, 'two distinct source reviewers required')
    need(all(set(item) == {'role','reviewer','decision'} and item['reviewer'] != '/root/pharmacy_recovery_readiness' and item['decision'] == 'APPROVE_ONE_ACQUISITION_ONLY' for item in reviews), 'acquisition decisions missing')
    return {'sourceSha256':source, 'launcherSha256':launcher, 'recipeFreezeSha256':RECIPE_SHA, 'pythonSha256':PYTHON_SHA}

def main():
    if len(sys.argv) == 1:
        print(json.dumps({'status':'NO_EFFECTS_DEFAULT','acquisitionAuthorized':False}))
        return 0
    pins = admit()  # All denials precede allocation and network.
    need(not os.path.lexists(QA/'ACQUISITION_RESULT.json'), 'existing outcome refused')
    with new_record(QA/'ACQUISITION_ONCE.json') as claim:
        write_all(claim, json_bytes({'status':'CONSUMED_BEFORE_ATTEMPT', **pins}))
        os.fsync(claim)
    factory = lambda: http.client.HTTPSConnection('nodejs.org', 443, timeout=10, context=ssl.create_default_context())
    result = recover(Path('/private/tmp'), factory, provenance=pins)
    result['writesStopped'] = True
    with new_record(QA/'ACQUISITION_RESULT.json') as output:
        write_all(output, json_bytes(result))
        os.fsync(output)
    print(json.dumps(result))
    return int(result['status'] != 'TOOL_BYTES_RECOVERED_NOT_EXECUTED' or bool(result['cleanupExceptions']))

@contextlib.contextmanager
def new_record(path):
    chain(path.parent)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        info = os.fstat(fd)
        regular(info)
        need(identity(info) == identity(path.lstat()), 'record path drift')
        yield fd
        need(identity(info) == identity(path.lstat()), 'record path drift')
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent)

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (Refusal, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'status':'REFUSED','reason':str(error)}))
        raise SystemExit(1)

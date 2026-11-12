"""Archive only the curated Git source bytes as inert .txt data; no subject evaluation."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import stat
import subprocess

BASE = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
QA = BASE / 'output/qa/pharmacy-fixture-recovery'
INVENTORY_SHA = '4b194c8124d14c89c19a2664c7c3f8f60a9aef002885317541457e09e08815b0'
PLAN_SHA = '7b4f866aa51d05bce4a93bbfcb5093df98d3827c3f266f02c1abb5dc138a50ed'
sha = lambda data: hashlib.sha256(data).hexdigest()

def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError('Expected independent regular file: ' + str(path))
    return info

def directory_chain(path):
    for item in [path, *path.parents]:
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('Non-directory or symlink ancestor: ' + str(item))

def write_new(path, data):
    directory_chain(path.parent)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    regular(path)
    if path.read_bytes() != data:
        raise RuntimeError('Written data differs: ' + str(path))

def encoded(value):
    return (json.dumps(value, indent=2) + '\n').encode()

directory_chain(QA)
script = Path(__file__)
regular(script)
script_sha = sha(script.read_bytes())
for source in [QA/'source-data-inventory.json', QA/'PREPARATION_DECISIONS.json', BASE/'documentation/planning/implementation/PHARMACY_FIXTURE_RECOVERY.md']:
    regular(source)
inventory_bytes = (QA/'source-data-inventory.json').read_bytes()
if sha(inventory_bytes) != INVENTORY_SHA:
    raise RuntimeError('Inventory changed')
if sha((BASE/'documentation/planning/implementation/PHARMACY_FIXTURE_RECOVERY.md').read_bytes()) != PLAN_SHA:
    raise RuntimeError('Recovery plan changed')
inventory = json.loads(inventory_bytes)
decision_bytes = (QA/'PREPARATION_DECISIONS.json').read_bytes()
decisions = json.loads(decision_bytes)
if decisions['inventorySha256'] != INVENTORY_SHA or decisions['planSha256'] != PLAN_SHA or decisions['rootAction'] != 'RECOVER_EXACT_SOURCE_DATA_TO_ARCHIVE_ONLY':
    raise RuntimeError('Preparation decision binding differs')
if len(decisions['decisions']) != 2 or any(item['decision'] != 'APPROVE_RECOVERY_PREPARATION_ONLY' for item in decisions['decisions']):
    raise RuntimeError('Missing two preparation decisions')
entries = inventory['entries']
if len(entries) != 74 or sum(item['bytes'] for item in entries) != 2357268:
    raise RuntimeError('Unexpected curated inventory coverage')
archive = QA/'restored'
manifest_path = QA/'RESTORATION.json'
if archive.exists() or archive.is_symlink() or manifest_path.exists() or manifest_path.is_symlink():
    raise RuntimeError('Refuse existing archive/manifest')
# Read and bind all sources before making archive paths. git show is source-data retrieval only.
git = '/usr/bin/git'
environment = {'PATH': '/usr/bin:/bin', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_OPTIONAL_LOCKS': '0'}
source_modes = {}
for ref in sorted({entry['ref'] for entry in entries}):
    if not re.fullmatch('[0-9a-f]{40}', ref):
        raise RuntimeError('Non-exact commit ref')
    tree = subprocess.run([git, '-C', str(BASE), 'ls-tree', '-rz', ref], check=True, capture_output=True, env=environment).stdout
    source_modes[ref] = {}
    for line in tree.split(b'\0'):
        if line:
            metadata, path = line.split(b'\t', 1)
            mode, kind, object_id = metadata.decode().split(' ')
            source_modes[ref][path.decode()] = (mode, kind)
unique = {}
index_entries = []
for entry in entries:
    ref, path, digest = entry['ref'], entry['path'], entry['sha256']
    components = PurePosixPath(path)
    if components.is_absolute() or '..' in components.parts or not re.fullmatch('[0-9a-f]{64}', digest):
        raise RuntimeError('Invalid curated source mapping')
    if source_modes[ref].get(path) not in [('100644', 'blob'), ('100755', 'blob')]:
        raise RuntimeError('Source is not a Git regular blob')
    data = subprocess.run([git, '-C', str(BASE), 'show', ref+':'+path], check=True, capture_output=True, env=environment).stdout
    if len(data) != entry['bytes'] or sha(data) != digest:
        raise RuntimeError('Source hash/size differs: ' + path)
    if digest in unique and unique[digest] != data:
        raise RuntimeError('Digest collision')
    unique[digest] = data
    index_entries.append({**entry, 'archivePath': 'blobs/'+digest+'.txt'})
archive.mkdir(mode=0o700)
(archive/'blobs').mkdir(mode=0o700)
for digest, data in sorted(unique.items()):
    write_new(archive/'blobs'/f'{digest}.txt', data)
index = {'schema':'SD-PHARMACY-INERT-SOURCE-ARCHIVE-1','status':'ARCHIVED_DATA_ONLY','inventorySha256':INVENTORY_SHA,'entryCount':len(entries),'mappedSourceBytes':sum(item['bytes'] for item in entries),'uniqueBlobCount':len(unique),'uniqueBlobBytes':sum(len(data) for data in unique.values()),'entries':index_entries,'missingReportedArtifacts':inventory['missingReportedArtifacts'],'activeTestFilesWritten':False,'subjectExecutionAuthorized':False,'newAcceptance':False}
index_bytes = encoded(index)
write_new(archive/'index.json', index_bytes)
# Read back every mapped archive file; no source parsing, loading or execution.
for entry in index_entries:
    target = archive/entry['archivePath']
    regular(target)
    data = target.read_bytes()
    if len(data) != entry['bytes'] or sha(data) != entry['sha256']:
        raise RuntimeError('Archive readback mismatch')
expected = {'index.json'} | {'blobs/'+digest+'.txt' for digest in unique}
actual = set()
for directory, folders, files in os.walk(archive, followlinks=False):
    directory_chain(Path(directory))
    for name in folders:
        directory_chain(Path(directory)/name)
    for name in files:
        target = Path(directory)/name
        regular(target)
        actual.add(target.relative_to(archive).as_posix())
if actual != expected:
    raise RuntimeError('Archive has unexpected or missing files')
if sha((QA/'source-data-inventory.json').read_bytes()) != INVENTORY_SHA or (QA/'PREPARATION_DECISIONS.json').read_bytes() != decision_bytes:
    raise RuntimeError('Existing inventory/decisions changed during archive')
manifest = {'schema':'SD-PHARMACY-SOURCE-DATA-RESTORATION-1','status':'ARCHIVED_DATA_ONLY','author':'/root/pharmacy_recovery_readiness','date':'2026-11-12','archive':'restored','script':script.name,'scriptSha256':script_sha,'sourceInventorySha256':INVENTORY_SHA,'preparationDecisionsSha256':sha(decision_bytes),'recoveryPlanSha256':PLAN_SHA,'index':'restored/index.json','indexSha256':sha(index_bytes),'entryCount':len(entries),'mappedSourceBytes':sum(item['bytes'] for item in entries),'uniqueBlobCount':len(unique),'uniqueBlobBytes':sum(len(data) for data in unique.values()),'archiveFileCount':len(expected),'all74MappingsReadBack':True,'regularIndependentFilesOnly':True,'symlinksObserved':False,'exclusiveNewPathsOnly':True,'contentDeduplicated':True,'existingInventoryAndDecisionsUnchanged':True,'sourceDataRetrievalOnly':True,'activeTestFilesWritten':False,'missingReportedArtifacts':inventory['missingReportedArtifacts'],'applicationChanges':False,'subjectExecutions':0,'toolDownloads':0,'packageRestorations':0,'networkCalls':0,'GitMutations':0,'correctionImplemented':False,'runtimeAccepted':False,'moduleAccepted':False,'newAcceptance':False,'writesStopped':True}
manifest_bytes = encoded(manifest)
write_new(manifest_path, manifest_bytes)
# After manifest persistence, perform reads/output only. No additional writes.
print(json.dumps({'status':manifest['status'],'entryCount':len(entries),'mappedSourceBytes':manifest['mappedSourceBytes'],'uniqueBlobCount':len(unique),'uniqueBlobBytes':manifest['uniqueBlobBytes'],'indexSha256':sha(index_bytes),'restorationSha256':sha(manifest_path.read_bytes()),'scriptSha256':script_sha,'writesStopped':True},indent=2))

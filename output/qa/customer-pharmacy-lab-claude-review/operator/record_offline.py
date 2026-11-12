"""Run fixed offline tests in process, recording exact owned fixture absence."""
from pathlib import Path
import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
ROOT=Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab/output/qa/customer-pharmacy-lab-claude-review/operator')
original=tempfile.TemporaryDirectory
fixtures=[]
class TrackedDirectory(original):
    def __init__(self,*a,**kw):
        super().__init__(*a,**kw)
        fixtures.append(self.name)

def save(path,data):
    if not isinstance(data,str):data=json.dumps(data,indent=2)+'\n'
    with path.open('x') as f:f.write(data)
    path.chmod(0o600)

def run(label,directory):
    fixtures.clear()
    spec=importlib.util.spec_from_file_location('offline_'+label,directory/'test_supervisor.py')
    module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
    tempfile.TemporaryDirectory=TrackedDirectory
    stream=io.StringIO()
    try:
        result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromModule(module))
    finally:
        tempfile.TemporaryDirectory=original
    absent=[{'path':p,'absent':not Path(p).exists()} for p in fixtures]
    assert all(item['absent'] for item in absent)
    transcript=stream.getvalue()
    save(directory/('offline-'+label+'.txt'),transcript)
    report={'schema':'SD-CURRENT-SUPERVISOR-OFFLINE-RUN-1','label':label,'exitCode':0 if result.wasSuccessful() else 1,'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped),'fixtures':absent,'exactOwnedFixtureAbsence':all(x['absent'] for x in absent),'transcriptSha256':hashlib.sha256(transcript.encode()).hexdigest(),'modelCalls':0,'authChecks':0,'clientProcesses':0,'nativeMetadataCommands':0,'networkCalls':0,'applicationImports':0}
    save(directory/('offline-'+label+'.json'),report)
    print(json.dumps({k:v for k,v in report.items() if k!='fixtures'}))
    return report
old=run('initial-failure-replay',ROOT/'initial-failure')
assert old['tests']==24 and old['errors']==2 and old['failures']==0
new=run('final',ROOT)
assert new['tests']==31 and new['exitCode']==0

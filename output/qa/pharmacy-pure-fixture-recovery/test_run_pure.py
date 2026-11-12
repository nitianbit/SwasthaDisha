"""Focused stdlib fakes. Popen is replaced for the ENTIRE run; no Node fallback."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import unittest
from unittest.mock import patch

blocked_starts=[]
def popen_tripwire(*args,**kwargs):
    blocked_starts.append(True)
    raise AssertionError('REAL_NODE_START_FORBIDDEN')

# Load under the same global tripwire used throughout all fake checks.
with patch.object(subprocess,'Popen',popen_tripwire):
    spec=importlib.util.spec_from_file_location('pure_launcher',Path(__file__).with_name('run-pure.py'))
    op=importlib.util.module_from_spec(spec);spec.loader.exec_module(op)

class FakeChild:
    def __init__(self,wait_failure=False):
        self.pid=123456789;self.returncode=None;self.wait_calls=0;self.wait_failure=wait_failure
        self.stdout=self.pipe(b'captured stdout');self.stderr=self.pipe(b'captured stderr')
    def pipe(self,data):
        r,w=os.pipe();os.write(w,data);os.close(w);return os.fdopen(r,'rb')
    def poll(self):return self.returncode
    def wait(self,timeout):
        self.wait_calls+=1
        if self.wait_failure:raise subprocess.TimeoutExpired('fake-only',timeout)
        self.returncode=0 if self.returncode is None else self.returncode;return self.returncode

class FakeChecks(unittest.TestCase):
    def setUp(self):
        self.workspace=tempfile.TemporaryDirectory(prefix='sd-pure-launcher-fakes-',dir='/private/tmp');self.root=Path(self.workspace.name)
    def tearDown(self):self.workspace.cleanup()
    def fake_child_result(self,failure):
        child=FakeChild(wait_failure=failure=='wait');original_selector=selectors.DefaultSelector;original_read=os.read
        class BrokenSelector(original_selector):
            calls=0
            def select(self,timeout=None):
                self.calls+=1
                if failure=='selector' and self.calls==2:raise OSError('first selector failure')
                return super().select(timeout)
        read_calls=0
        def maybe_read(*args):
            nonlocal read_calls
            read_calls+=1
            if failure=='read' and read_calls==2:raise OSError('first read failure')
            return original_read(*args)
        ticks=iter([0,0,31] if failure=='deadline' else [])
        with patch.object(op,'verify_node',return_value=None) as verified, patch.object(subprocess,'Popen',return_value=child) as spawn, patch.object(op.selectors,'DefaultSelector',BrokenSelector), patch.object(op.os,'read',maybe_read), patch.object(op.os,'killpg',side_effect=lambda *a:setattr(child,'returncode',-9)), patch.object(op.time,'monotonic',side_effect=(lambda:next(ticks)) if failure=='deadline' else op.time.monotonic):
            result=op.run_child(self.root,'fake.cjs',[1,2,3])
        self.assertEqual(verified.call_count,1);self.assertEqual(spawn.call_count,1)
        self.assertTrue(result['started']);self.assertEqual(result['pid'],child.pid)
        self.assertEqual(result['stdout'],b'captured stdout');self.assertEqual(result['stderr'],b'captured stderr')
        self.assertIsNotNone(result['failure']);self.assertEqual(len(result['argv']),4)
        self.assertTrue(child.stdout.closed and child.stderr.closed)
        return result
    def test_child_failures_keep_output_start_exit_and_first_failure(self):
        for stage in ['selector','read','wait','deadline']:
            with self.subTest(stage=stage):
                result=self.fake_child_result(stage)
                if stage=='wait':
                    self.assertEqual(result['failure']['type'],'TimeoutExpired');self.assertTrue(result['cleanupErrors'])
                else:self.assertIsNotNone(result['exitCode'])
    def test_node_recheck_refuses_before_any_child_start(self):
        with patch.object(op,'verify_node',side_effect=RuntimeError('changed Node')):
            result=op.run_child(self.root,'fake.cjs',[1,2,3])
        self.assertFalse(result['started']);self.assertIsNone(result['exitCode']);self.assertEqual(result['stdout'],b'');self.assertIn('changed Node',result['failure']['message'])
    def test_allocation_open_failure_cleans_owned_empty_lease(self):
        records=self.root/'records';records.mkdir();original_open=os.open;captured=[]
        def fail_open(path,flags,*a,**kw):
            if str(path).startswith('/private/tmp/sd-pharmacy-pure-') and flags&os.O_DIRECTORY:
                captured.append(str(path));raise OSError('first lease fd failure')
            return original_open(path,flags,*a,**kw)
        with patch.object(op.os,'open',fail_open):result=op.subject({'id':'alloc','entry':'fake.cjs'},{},records,[1,2,3])
        self.assertFalse(result['started']);self.assertEqual(result['cleanup'],'VERIFIED_FRESH_ABSENCE');self.assertFalse(os.path.lexists(captured[0]));self.assertEqual(result['firstFailure']['message'],'first lease fd failure')
    def test_record_directory_failure_closes_lease_descriptor(self):
        records=self.root/'records';records.mkdir();original_mkdir=Path.mkdir;original_open=os.open;fds=[]
        def fail_mkdir(path,*a,**kw):
            if path.parent==records:raise PermissionError('first record directory failure')
            return original_mkdir(path,*a,**kw)
        def observed_open(path,flags,*a,**kw):
            fd=original_open(path,flags,*a,**kw)
            if str(path).startswith('/private/tmp/sd-pharmacy-pure-') and flags&os.O_DIRECTORY:fds.append(fd)
            return fd
        with patch.object(Path,'mkdir',fail_mkdir),patch.object(op.os,'open',observed_open):result=op.subject({'id':'record','entry':'fake.cjs'},{},records,[1,2,3])
        self.assertFalse(result['started']);self.assertFalse(result['recordPersisted']);self.assertEqual(result['cleanup'],'VERIFIED_FRESH_ABSENCE')
        self.assertEqual(result['firstFailure']['message'],'first record directory failure')
        for fd in fds:
            with self.assertRaises(OSError):os.fstat(fd)
    def test_failed_cleanup_retains_exact_path_and_first_allocation_failure(self):
        records=self.root/'records';records.mkdir();original_mkdir=Path.mkdir;original_rmdir=Path.rmdir
        def fail_mkdir(path,*a,**kw):
            if path.parent==records:raise PermissionError('first allocation failure')
            return original_mkdir(path,*a,**kw)
        def fail_rmdir(path,*a,**kw):
            if str(path).startswith('/private/tmp/sd-pharmacy-pure-'):raise OSError('later cleanup failure')
            return original_rmdir(path,*a,**kw)
        with patch.object(Path,'mkdir',fail_mkdir),patch.object(Path,'rmdir',fail_rmdir):result=op.subject({'id':'cleanup','entry':'fake.cjs'},{},records,[1,2,3])
        lease=Path(result['lease'])
        try:
            self.assertEqual(result['firstFailure']['message'],'first allocation failure');self.assertIn(str(lease),result['unresolvedPaths']);self.assertTrue(result['cleanupErrors'])
            self.assertEqual(op.ident(lease.lstat()),tuple(result['leaseIdentity']))
        finally:lease.rmdir()
    def test_captured_sources_plan_and_controls_survive_disk_drift_without_reopen(self):
        qa=self.root/'output/qa/pharmacy-pure-fixture-recovery';qa.mkdir(parents=True)
        baseline=b'baseline bytes';baseline_sha=op.sha(baseline)
        names={'output/qa/pharmacy-pure-fixture-recovery/PLAN.json':json.dumps({'sourceFiles':['bootstrap.cjs'],'jobs':[{'id':'normal','entry':'bootstrap-unit.cjs'},{'id':'control','entry':'cursor-creation-pure.test.cjs','control':True,'before':'safe','after':'changed','sha256':op.sha(b'changed bytes')}]}).encode(),'test/inventory-runtime/scenario/bootstrap.cjs':b'safe bytes','output/qa/pharmacy-fixture-recovery/restored/blobs/'+baseline_sha+'.txt':baseline}
        for name,data in names.items():path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        freeze_bytes=op.encode({'inputs':{name:op.sha(data) for name,data in names.items()},'nodeIdentity':[1,2,3]})
        with patch.object(op,'BASE',self.root),patch.object(op,'BASELINE_SHA',baseline_sha):snapshot=op.capture_snapshot(freeze_bytes)
        for name in names:(self.root/name).write_bytes(b'drift after admission')
        observed=[]
        def fake_subject(job,files,*args):observed.append(files['bootstrap.cjs']);return {'status':'PURE_ENTRY_COMPLETE','started':job['id']=='normal'}
        with patch.object(op,'QA',qa),patch.object(op,'preflight',return_value=snapshot),patch.object(op,'read',side_effect=AssertionError('snapshot reopened')),patch.object(op,'subject',fake_subject),patch.object(op.sys,'argv',['fake','--run-once']),contextlib.redirect_stdout(io.StringIO()):self.assertEqual(op.main(),0)
        self.assertEqual(observed,[b'safe bytes',b'changed bytes']);report=json.loads((qa/'RUN_RESULT.json').read_bytes());self.assertEqual(report['NodeEntriesStarted'],1)

if __name__=='__main__':
    with patch.object(subprocess,'Popen',popen_tripwire):result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FakeChecks))
    print(json.dumps({'schema':'SD-PURE-LAUNCHER-FAKE-CHECKS-1','tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),'realPopenTripwireAttempts':len(blocked_starts),'NodeExecutions':0}))
    raise SystemExit(not(result.wasSuccessful() and not blocked_starts))

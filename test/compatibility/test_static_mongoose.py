"""Offline controller regressions; npm, network and compiler are simulated."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.parse

SPEC = importlib.util.spec_from_file_location('static_probe', Path(__file__).with_name('static_mongoose.py'))
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)
SOURCE_ROOT = PROBE.ROOT


class StaticProbeSafety(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix='sd-static-probe-test-', dir='/private/tmp')
        self.addCleanup(self.area.cleanup)
        self.root = Path(self.area.name).resolve()
        for name in PROBE.GUARDED:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE_ROOT / name, target)
        self.node = self.root / 'tools/node'
        self.node.parent.mkdir()
        self.node.write_text('synthetic executable; never invoked')
        self.npm = self.root / 'tools/npm/bin/npm-cli.js'
        self.npm.parent.mkdir(parents=True)
        self.npm.write_text('synthetic npm; never invoked')
        (self.npm.parents[1] / 'package.json').write_text('{"version":"synthetic"}')
        self.allocated = []
        self.real_allocate = tempfile.mkdtemp
        self.registry_failure = False
        self.missing_module = False
        self.wrong_negative = False

    def allocate(self, *args, **kwargs):
        kwargs['dir'] = str(self.root)  # Keep a regressed leak inside the outer owned test fixture.
        path = self.real_allocate(*args, **kwargs)
        self.allocated.append(Path(path))
        return path

    def metadata(self, url, timeout):
        if self.registry_failure:
            raise ConnectionError('synthetic registry outage')
        name, version = urllib.parse.unquote(urllib.parse.urlsplit(url).path).lstrip('/').rsplit('/', 1)
        package = {'name': name, 'version': version, 'dist': {
            'tarball': 'https://registry.npmjs.org/synthetic/-/package.tgz',
            'integrity': 'sha512-synthetic-offline-transport-only'}}

        class Response:
            def __enter__(self):
                self.url = url
                return self

            def __exit__(self, *args):
                return False

            def read(self, size):
                return json.dumps(package).encode()

        return Response()

    def process(self, args, cwd, **kwargs):
        args = [str(value) for value in args]
        case = Path(cwd)
        output = ''
        status = 0
        if str(self.npm) in args:
            if 'config' in args:
                output = next(arg.split('=', 1)[1] for arg in args if arg.startswith('--userconfig='))
            elif 'install' in args:
                deps = json.loads((case / 'package.json').read_text())['dependencies']
                packages = {'': {'name': 'synthetic'}}
                for name, version in deps.items():
                    packages['node_modules/' + name] = {'version': version,
                        'resolved': 'https://registry.npmjs.org/synthetic/-/package.tgz',
                        'integrity': 'sha512-synthetic-offline-transport-only'}
                packages['node_modules/mongodb'] = {'version': '4.17.2' if case.name == '6.13.8' else '7.8.0',
                    'resolved': 'https://registry.npmjs.org/synthetic/-/driver.tgz', 'integrity': 'sha512-synthetic'}
                (case / 'package-lock.json').write_text(json.dumps({'packages': packages}))
            elif 'ci' not in args:
                raise AssertionError('Unexpected npm operation')
        elif any(arg.endswith('/typescript/lib/tsc.js') for arg in args):
            config = json.loads((case / 'tsconfig.json').read_text())
            if config['files'] == ['negative.ts']:
                filename = 'some-declaration.d.ts' if self.wrong_negative else 'negative.ts'
                output = filename + '(1,14): error TS2322: synthetic negative\n'
                status = 2
            else:
                if self.missing_module:
                    output = 'src1/modules/blogs/repository/index.ts(1,1): error TS2307: synthetic missing module\n'
                    status = 2
                elif case.name == '9.12.0':
                    output = 'src1/modules/common/repository/BaseRepository.ts(4,3): error TS2305: synthetic removed export\n'
                    status = 2
                output += '\n'.join(str(case / name) for name in config['files']) + '\n'
        else:
            raise AssertionError('Unexpected child process')
        return subprocess.CompletedProcess(args, status, output, '')

    def invoke(self):
        opener = mock.Mock()
        opener.open.side_effect = self.metadata
        with mock.patch.object(PROBE, 'ROOT', self.root), \
                mock.patch.object(PROBE.sys, 'argv', ['probe', str(self.node), str(self.npm)]), \
                mock.patch.object(PROBE.subprocess, 'check_output', return_value='v22.23.4\n'), \
                mock.patch.object(PROBE.subprocess, 'run', side_effect=self.process), \
                mock.patch.object(PROBE.urllib.request, 'build_opener', return_value=opener), \
                mock.patch.object(PROBE.tempfile, 'mkdtemp', side_effect=self.allocate), \
                contextlib.redirect_stdout(io.StringIO()):
            PROBE.main()

    def report(self):
        paths = list((self.root / 'output/qa/m0-a/c2-static').glob('*/verification.json'))
        self.assertEqual(len(paths), 1)
        report = json.loads(paths[0].read_text())
        self.assertTrue(report['rootHashesUnchanged'])
        self.assertTrue(report['ownedWorkspaceRemoved'])
        self.assertTrue(all(not path.exists() for path in self.allocated))
        return report

    def test_migration_diagnostic_can_complete_the_static_comparison(self):
        self.invoke()
        result = self.report()
        self.assertTrue(result['completed'])
        self.assertEqual([case['exitCode'] for case in result['candidates']], [0, 2])

    def test_invalid_tool_metadata_allocates_no_workspace(self):
        (self.npm.parents[1] / 'package.json').write_text('invalid JSON')
        with self.assertRaises(json.JSONDecodeError):
            self.invoke()
        self.assertEqual(self.allocated, [])

    def test_registry_failure_keeps_root_readback_and_cleanup_evidence(self):
        self.registry_failure = True
        with self.assertRaisesRegex(ConnectionError, 'synthetic registry outage'):
            self.invoke()
        result = self.report()
        self.assertFalse(result['completed'])
        self.assertEqual(result['errorClass'], 'ConnectionError')

    def test_missing_module_cannot_complete_a_comparison(self):
        self.missing_module = True
        with self.assertRaisesRegex(ValueError, 'resolution failed'):
            self.invoke()
        self.assertFalse(self.report()['completed'])

    def test_unrelated_negative_diagnostic_cannot_satisfy_the_canary(self):
        self.wrong_negative = True
        with self.assertRaisesRegex(ValueError, 'negative compiler check'):
            self.invoke()
        self.assertFalse(self.report()['completed'])


if __name__ == '__main__':
    unittest.main()

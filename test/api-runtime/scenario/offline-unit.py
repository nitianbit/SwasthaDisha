"""Built-in-only fake lock tests. No npm/compiler/application/Docker/DB calls."""
import base64
import copy
from pathlib import Path
import runpy
import unittest

PREP = runpy.run_path(str(Path(__file__).with_name('prepare.py')), run_name='offline_preparation_definitions')
INTEGRITY = 'sha512-' + base64.b64encode(bytes(64)).decode()


def row(version='1.0.0', dependencies=None):
    return {'version': version, 'integrity': INTEGRITY,
            'resolved': 'https://registry.npmjs.org/public/-/public-' + version + '.tgz',
            **({'dependencies': dependencies} if dependencies else {})}


class LockedPublicInputs(unittest.TestCase):
    def test_registry_integrity_positive(self):
        PREP['lock_rows']({'packages': {'': {}, 'node_modules/public': row()}})

    def reject_entry(self, key, value):
        value_row = row(); value_row[key] = value
        with self.assertRaises((RuntimeError, ValueError)):
            PREP['lock_rows']({'packages': {'node_modules/public': value_row}})

    def test_http_denied(self): self.reject_entry('resolved', 'http://registry.npmjs.org/a.tgz')
    def test_other_host_denied(self): self.reject_entry('resolved', 'https://example.com/a.tgz')
    def test_credentials_denied(self): self.reject_entry('resolved', 'https://user:pass@registry.npmjs.org/a.tgz')
    def test_query_denied(self): self.reject_entry('resolved', 'https://registry.npmjs.org/a.tgz?token=x')
    def test_fragment_denied(self): self.reject_entry('resolved', 'https://registry.npmjs.org/a.tgz#fragment')
    def test_nonsha512_denied(self): self.reject_entry('integrity', 'sha1-' + 'a' * 40)
    def test_short_integrity_denied(self): self.reject_entry('integrity', 'sha512-YQ==')
    def test_invalid_base64_denied(self): self.reject_entry('integrity', 'sha512-a')
    def test_link_denied(self): self.reject_entry('link', True)
    def test_bundle_denied(self): self.reject_entry('inBundle', True)

    def test_nested_and_deduped_closure(self):
        old = {'packages': {'node_modules/a': row(dependencies={'b': '1.0.0'}), 'node_modules/a/node_modules/b': row()}}
        new = {'packages': {'node_modules/a': row(dependencies={'b': '1.0.0'}), 'node_modules/b': row()}}
        PREP['preserve_root_closures'](old, new, ['a'])

    def test_transitive_version_drift_denied(self):
        old = {'packages': {'node_modules/a': row(dependencies={'b': '^1'}), 'node_modules/b': row()}}
        new = copy.deepcopy(old); new['packages']['node_modules/b']['version'] = '1.1.0'
        with self.assertRaises(RuntimeError): PREP['preserve_root_closures'](old, new, ['a'])

    def test_transitive_integrity_drift_denied(self):
        old = {'packages': {'node_modules/a': row(dependencies={'b': '1'}), 'node_modules/b': row()}}
        new = copy.deepcopy(old); new['packages']['node_modules/b']['integrity'] += 'changed'
        with self.assertRaises(RuntimeError): PREP['preserve_root_closures'](old, new, ['a'])

    def test_added_dependency_denied(self):
        old = {'packages': {'node_modules/a': row()}}
        new = copy.deepcopy(old); new['packages']['node_modules/a']['dependencies'] = {'b': '1'}
        with self.assertRaises(RuntimeError): PREP['preserve_root_closures'](old, new, ['a'])

    def test_missing_dependency_denied(self):
        value = {'packages': {'node_modules/a': row(dependencies={'b': '1'})}}
        with self.assertRaises(RuntimeError): PREP['preserve_root_closures'](value, copy.deepcopy(value), ['a'])


if __name__ == '__main__':
    unittest.main()

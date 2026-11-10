"""Pure fixed-activation admission tests: no private files or real processes."""
import importlib.util
import copy
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('activation', Path(__file__).with_name('activate.py'))
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


def forbidden(*args, **kwargs):
    raise AssertionError('REAL_PROCESS_PORT_FORBIDDEN')


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.expected = {'schema': 'SD-LOCAL-RUFLO-ACTIVATION-APPROVAL-1',
            'decision': activation.DECISION, 'planSha': 'a' * 64,
            'programSha': 'b' * 64, 'sourceRoot': '/synthetic', 'smokeSha': 'c' * 64}
    def receipt(self):
        return {**self.expected, 'reviewers': [{'agent': '/root', 'decision': activation.DECISION},
            {'agent': '/root/backend_boot_path', 'decision': activation.DECISION}]}
    def test_two_actual_nonauthor_identifiers_include_canonical_root(self):
        activation.validate_approval(self.receipt(), self.expected)
    def test_every_binding_matters(self):
        for key in self.expected:
            candidate = self.receipt(); candidate[key] = 'changed'
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                activation.validate_approval(candidate, self.expected)
    def test_extra_field_denied(self):
        candidate = self.receipt(); candidate['command'] = 'unknown'
        with self.assertRaises(RuntimeError): activation.validate_approval(candidate, self.expected)
    def test_author_reviewer_denied(self):
        candidate = self.receipt(); candidate['reviewers'][1]['agent'] = activation.AUTHOR
        with self.assertRaises(RuntimeError): activation.validate_approval(candidate, self.expected)
    def test_duplicate_review_denied(self):
        candidate = self.receipt(); candidate['reviewers'][1]['agent'] = '/root'
        with self.assertRaises(RuntimeError): activation.validate_approval(candidate, self.expected)
    def test_wrong_stage_decision_denied(self):
        candidate = self.receipt(); candidate['reviewers'][1]['decision'] = 'APPROVE_SOURCE_ONLY'
        with self.assertRaises(RuntimeError): activation.validate_approval(candidate, self.expected)
    def test_malformed_identity_and_extra_payload_denied(self):
        for value in ['', '/root/', '/root/../x', 'claude', activation.AUTHOR]:
            candidate = self.receipt(); candidate['reviewers'][1]['agent'] = value
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                activation.validate_approval(candidate, self.expected)
        candidate = self.receipt(); candidate['reviewers'][1]['token'] = 'synthetic'
        with self.assertRaises(RuntimeError): activation.validate_approval(candidate, self.expected)

    def test_fixed_isolated_invocation_accepts_only_platform_locale_metadata(self):
        activation.validate_invocation(['activate.py'], True, {'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp',
            'LC_CTYPE': 'UTF-8', '__CF_USER_TEXT_ENCODING': 'synthetic-platform-metadata'})

    def test_invocation_rejects_arguments_ambient_auth_and_nonisolated_start(self):
        environment = {'PATH': '/usr/bin:/bin', 'TMPDIR': '/private/tmp'}
        for args, isolated, env in [(['activate.py', '--force'], True, environment),
                                   (['activate.py'], False, environment),
                                   (['activate.py'], True, {**environment, 'ANTHROPIC_API_KEY': 'synthetic'}),
                                   (['activate.py'], True, {**environment, 'NODE_OPTIONS': 'synthetic'}),
                                   (['activate.py'], True, {**environment, 'TMPDIR': '/elsewhere'})]:
            with self.subTest(args=args, isolated=isolated, keys=sorted(env)), self.assertRaises(RuntimeError):
                activation.validate_invocation(args, isolated, env)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.before = b'# preserve this\n[unrelated]\nx = "same"\n[mcp_servers.ruflo]\ncommand = "/node"\nargs = ["/cli", "mcp", "start"]\ncwd = "/state"\n'
        self.after = self.before.replace(b'args = ["/cli", "mcp", "start"]', b'args = ["/adapter"]')
        self.profile = {'command': '/node', 'args': ['/adapter'], 'cwd': '/state'}
    def test_only_existing_ruflo_args_line_can_change(self):
        activation.validate_candidate(self.before, self.after, self.profile)
    def test_unrelated_byte_change_denied(self):
        for candidate in [self.after.replace(b'preserve', b'changed'), self.after + b'# extra\n',
                          self.after.replace(b'cwd = "/state"', b'cwd = "/elsewhere"')]:
            with self.subTest(candidate=candidate), self.assertRaises(RuntimeError):
                activation.validate_candidate(self.before, candidate, self.profile)
    def test_changed_other_table_args_denied(self):
        before = self.before + b'[mcp_servers.other]\nargs = ["other"]\n'
        after = before.replace(b'args = ["other"]', b'args = ["/adapter"]')
        with self.assertRaises(RuntimeError): activation.validate_candidate(before, after, self.profile)
    def test_profile_must_match_exact_public_candidate(self):
        with self.assertRaises(RuntimeError): activation.validate_candidate(self.before, self.after, {**self.profile, 'env_vars': []})


class ClaudeStateTests(unittest.TestCase):
    def setUp(self):
        self.before = {'mcpServers': {'other': {'command': 'unchanged'}}, 'ordinaryFlag': True}
        self.profile = {'type': 'stdio', 'command': '/node', 'args': ['/adapter']}
        self.after = copy.deepcopy(self.before); self.after['mcpServers']['ruflo'] = self.profile.copy()
    def test_only_omitted_or_empty_new_server_env_is_equivalent(self):
        activation.validate_claude_state(self.before, self.after, self.profile)
        self.after['mcpServers']['ruflo']['env'] = {}
        activation.validate_claude_state(self.before, self.after, self.profile)
    def test_nonempty_env_auth_and_unknown_new_fields_are_denied(self):
        for key, value in [('env', {'NODE_OPTIONS': 'synthetic'}), ('env', None),
                           ('bearer_token_env_var', 'ANTHROPIC_API_KEY'), ('url', 'https://example.invalid'),
                           ('unknown', True)]:
            changed = copy.deepcopy(self.after); changed['mcpServers']['ruflo'][key] = value
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                activation.validate_claude_state(self.before, changed, self.profile)
    def test_unrelated_fields_and_boolean_numeric_change_are_denied(self):
        for changed in [{**self.after, 'ordinaryFlag': 1}, {**self.after, 'newField': True},
                        {**self.after, 'ordinaryFlag': False}]:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                activation.validate_claude_state(self.before, changed, self.profile)


if __name__ == '__main__':
    with patch.object(subprocess, 'Popen', forbidden), patch.object(subprocess, 'run', forbidden), \
         patch.object(subprocess, 'check_output', forbidden):
        unittest.main(verbosity=2)

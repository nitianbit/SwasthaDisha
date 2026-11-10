"""Verify the JWT secret fail-closed amendment as source data, never as TypeScript.

config.ts and consumers are read as text. Validator conditions are matched against a closed
table of literal atoms and a Python decision model is evaluated over synthetic inputs; no
TypeScript, application, compiler, script, DB or provider is executed.

Binding gate: EXACT_TRANSFORM (candidate equals the baseline plus the reviewed transform)
together with PROTECTED_PINS and DIFF_SCOPE. The named semantic checks are diagnostic: they
run first so every negative control is rejected for a stated reason, but acceptance is bound
by the exact transform and scope, not by the semantic checks alone.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASELINE = '9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d'
SOURCE = 'src1/config/config.ts'
BASELINE_SHA256 = '0fcb0df49527c155083d2f3e4c81b36650bab14e207b5635a0831b2827d884e1'
PLACEHOLDERS = ('your-secret-key', 'your-secret-key-change-in-production')
DOTENV_LINE = "dotenv.config({ path: path.resolve(process.cwd(), '.env') });"
OLD_INIT = "  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY || 'your-secret-key',\n"
NEW_INIT = '  JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY),\n'
MESSAGE = 'JWT_SECRET_KEY must be set to a non-placeholder value'
VALIDATOR = """const JWT_SECRET_PLACEHOLDERS = ['your-secret-key', 'your-secret-key-change-in-production'];

function requireJwtSecret(value: string | undefined): string {
  if (
    value === undefined ||
    value.trim() === '' ||
    JWT_SECRET_PLACEHOLDERS.includes(value.trim())
  ) {
    throw new Error('JWT_SECRET_KEY must be set to a non-placeholder value');
  }
  return value;
}

"""
CONSUMERS = {  # path -> (jwt.sign count, jwt.verify count)
    'src1/modules/middleware/auth.ts': (0, 1),
    'src1/modules/auth/services/index.ts': (3, 0),
    'src1/modules/settings/services/index.ts': (0, 0),
}
PINNED = (
    'src1/index.ts', 'src1/modules/middleware/auth.ts', 'src1/modules/auth/services/index.ts',
    'src1/modules/settings/services/index.ts', 'src1/modules/settings/types/index.ts',
    'src1/modules/settings/index.ts', 'src1/db/index.ts', 'src1/scripts/syncIndexes.ts',
    'src1/scripts/migratePharmacyInventoryBatches.ts', 'test/pharmacy.integration.test.ts',
    'test/application/bootstrap.mjs', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json',
)
SCOPE = ('src1', 'test', 'package.json', 'package-lock.json', 'tsconfig.json')
VALIDATOR_SHA256 = hashlib.sha256(VALIDATOR.encode()).hexdigest()


class Rejected(Exception):
    def __init__(self, check, detail=''):
        super().__init__(check + (': ' + detail if detail else ''))
        self.check = check


class ModelCrash(Exception):
    """Modeled method call on undefined (a TypeError in the source)."""


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def expected_source():
    original = git('show', BASELINE + ':' + SOURCE).decode()
    assert hashlib.sha256(original.encode()).hexdigest() == BASELINE_SHA256, 'baseline hash changed'
    anchor = DOTENV_LINE + '\n\n'
    assert original.count(anchor) == 1 and original.count(OLD_INIT) == 1
    out = original.replace(anchor, anchor + VALIDATOR, 1)
    return original, out.replace(OLD_INIT, NEW_INIT, 1)


# ---------------------------------------------------------------- validator model

def strip_js(v):
    if v is None:
        raise ModelCrash()
    return v.strip()


ATOMS = {
    'value === undefined': lambda v, ph: v is None,
    "value === ''": lambda v, ph: v == '',
    '!value': lambda v, ph: v is None or v == '',
    "value.trim() === ''": lambda v, ph: strip_js(v) == '',
    "value.trim() !== ''": lambda v, ph: strip_js(v) != '',
    'JWT_SECRET_PLACEHOLDERS.includes(value.trim())': lambda v, ph: strip_js(v) in ph,
    'JWT_SECRET_PLACEHOLDERS.includes(value)': lambda v, ph: v in ph,
    'JWT_SECRET_PLACEHOLDERS.includes(value.trim().toLowerCase())': lambda v, ph: strip_js(v).lower() in ph,
}
RETURNS = {'return value;': lambda v: v, 'return value.trim();': strip_js}


def validator_span(src):
    m = re.search(r'^(async )?function requireJwtSecret\((.*)\)(: [^{\n]+)? \{$', src, re.M)
    if not m:
        raise Rejected('VALIDATOR_PRESENT', 'requireJwtSecret declaration missing')
    end = src.index('\n}\n', m.end())
    return m, src[m.end() + 1:end]


def parse_validator(body):
    m = re.fullmatch(r"\s*if \((.*?)\) \{\s*(.*?)\s*\}\s*(return [^;]+;)\s*", body, re.S)
    if not m:
        raise Rejected('CLOSED_VOCABULARY', 'validator is not a single guard followed by a return')
    cond = re.sub(r'\s+', ' ', m.group(1)).strip()
    atoms = []
    for part in cond.split(' || '):
        if part.strip() not in ATOMS:
            raise Rejected('CLOSED_VOCABULARY', 'unsupported condition atom: ' + part.strip())
        atoms.append(ATOMS[part.strip()])
    action = m.group(2).strip()
    if not re.fullmatch(r"throw new Error\('[^'`$]*'\);", action):
        raise Rejected('CLOSED_VOCABULARY', 'guard action is not a fixed Error throw')
    if m.group(3) not in RETURNS:
        raise Rejected('CLOSED_VOCABULARY', 'unsupported return: ' + m.group(3))
    return atoms, RETURNS[m.group(3)]


def model(atoms, ret, placeholders, value):
    try:
        if any(a(value, placeholders) for a in atoms):  # JS || short-circuits left to right
            return ('reject',)
        return ('accept', ret(value))
    except ModelCrash:
        return ('crash',)


MATRIX = (
    ('PRESENCE_CHECK', [None, '', ' ', '\t\n'], ('reject',)),
    ('PLACEHOLDER_REJECTED', ['your-secret-key', 'your-secret-key-change-in-production',
                              ' your-secret-key ', 'your-secret-key-change-in-production\n'], ('reject',)),
    ('VALID_ACCEPTED', ['synthetic-test-key-not-a-secret', 'Your-Secret-Key', 'x'], None),
    ('RAW_VALUE_RETURNED', [' padded-synthetic ', 'synthetic\t'], None),
)


# ---------------------------------------------------------------- semantic checks

def semantic_failures(src, overrides=None):
    failures = []
    try:
        header, body = validator_span(src)
    except Rejected as r:
        failures.append(str(r))
        header = body = None
    if header:
        if header.group(1) or header.group(3) != ': string' or header.group(2) != 'value: string | undefined':
            failures.append('GUARD_SYNCHRONOUS: validator must be a synchronous (value: string | undefined): string')
    if re.search(r'\btry\s*\{|\bcatch\b|\.catch\(', src):
        failures.append('NO_TRY_CATCH: validation failure must not be caught at load')
    dotenv = [m.start() for m in re.finditer(r'^' + re.escape(DOTENV_LINE) + r'$', src, re.M)]
    later = [m.start() for m in re.finditer(r'function requireJwtSecret\(|const JWT_SECRET_PLACEHOLDERS|requireJwtSecret\(process\.env', src)]
    if len(dotenv) != 1 or not later or min(later) < dotenv[0]:
        failures.append('DOTENV_BEFORE_VALIDATION: .env must load before the validator and its call')
    init = re.findall(r'^  JWT_SECRET_KEY: requireJwtSecret\((.*)\),$', src, re.M)
    config_pos = src.find('export const CONFIG')
    if len(init) != 1 or len(re.findall(r'requireJwtSecret\(', src)) != 2 or not header or \
            header.start() > config_pos or src.find('  JWT_SECRET_KEY: requireJwtSecret(') < config_pos:
        failures.append('VALIDATED_AT_LOAD: CONFIG initializer must call the validator once at module load')
    key_lines = re.findall(r'^.*JWT_SECRET_KEY\b.*$', src[config_pos:], re.M) if config_pos >= 0 else []
    literal_counts = [len(re.findall(re.escape("'%s'" % p), src)) for p in PLACEHOLDERS]
    if init != ['process.env.JWT_SECRET_KEY'] or any('||' in ln or '??' in ln for ln in key_lines) or \
            literal_counts != [1, 1] or (body and re.search(r"(\|\||\?\?)\s*'", body)):
        failures.append('NO_LITERAL_FALLBACK: no literal fallback; placeholders only in the rejection list')
    if (body and 'NODE_ENV' in body) or any('NODE_ENV' in ln for ln in key_lines):
        failures.append('UNCONDITIONAL: secret validation must not depend on NODE_ENV')
    const = re.search(r'^const JWT_SECRET_PLACEHOLDERS = \[(.*?)\];$', src, re.M | re.S)
    placeholders = tuple(re.findall(r"'([^']*)'", const.group(1))) if const else ()
    if sorted(placeholders) != sorted(PLACEHOLDERS):
        failures.append('PLACEHOLDER_SET_EXACT: placeholders must be exactly ' + ', '.join(PLACEHOLDERS))
    if body is not None:
        if re.search(r'\.length|/[^/\n]+/[gimsuy]*\.test|\.test\(|\.match\(|[<>]=?\s*\d', body):
            failures.append('NO_STRENGTH_POLICY: no invented length/format/entropy policy')
        if 'throw new Error(' not in body or re.search(r'console\.|logger|process\.exit', body):
            failures.append('THROWS_NOT_WARNS: invalid secret must throw, not warn or exit')
        errors = re.findall(r'throw new Error\((.*?)\);', body, re.S)
        if any(e != "'%s'" % MESSAGE for e in errors):
            failures.append('FIXED_MESSAGE: error message must be the fixed literal and never echo the value')
        try:
            atoms, ret = parse_validator(body)
        except Rejected as r:
            failures.append(str(r))
        else:
            for check, values, want in MATRIX:
                for value in values:
                    got = model(atoms, ret, placeholders, value)
                    expect = want or ('accept', value)
                    if got != expect:
                        failures.append('%s: input %r gave %r' % (check, value, got))
                        break
    failures += single_secret_source(src, overrides or {})
    return failures


def single_secret_source(src, overrides):
    failures = []
    if len(re.findall(r'process\.env\.JWT_SECRET_KEY', src)) != 1:
        failures.append('SINGLE_SECRET_SOURCE: config must read process.env.JWT_SECRET_KEY exactly once')
    for path, (signs, verifies) in CONSUMERS.items():
        text = overrides.get(path, (ROOT / path).read_text())
        secrets = re.findall(r'jwt\.(sign|verify)\([^,]+,\s*([^,)]+)', text)
        if 'process.env.JWT_SECRET_KEY' in text or any(s != 'CONFIG.JWT_SECRET_KEY' for _, s in secrets) or \
                [k for k, _ in secrets].count('sign') != signs or [k for k, _ in secrets].count('verify') != verifies:
            failures.append('SINGLE_SECRET_SOURCE: %s must use only CONFIG.JWT_SECRET_KEY' % path)
    return failures


def first_check(failure):
    return failure.split(':', 1)[0]


def check(candidate, expected, overrides=None):
    failures = semantic_failures(candidate, overrides)
    if failures:
        return first_check(failures[0]), failures
    if candidate != expected:
        return 'EXACT_TRANSFORM', ['EXACT_TRANSFORM: config differs from the reviewed transform']
    return None


def tree_checks():
    for path in PINNED:
        if (ROOT / path).read_bytes() != git('show', BASELINE + ':' + path):
            return 'PROTECTED_PINS', ['PROTECTED_PINS: ' + path]
    changed = git('diff', '--name-only', BASELINE, '--', *SCOPE).decode().split()
    untracked = git('ls-files', '--others', '--exclude-standard', '--', *SCOPE).decode().split()
    if changed + untracked != [SOURCE]:
        return 'DIFF_SCOPE', ['DIFF_SCOPE: %s' % (changed + untracked)]
    return None


# ---------------------------------------------------------------- negative controls

def mutate(text, old, new):
    assert text.count(old) >= 1, 'control anchor missing: ' + old[:60]
    return text.replace(old, new, 1)


def controls(original, expected):
    body_if = "  if (\n    value === undefined ||\n    value.trim() === '' ||\n"
    dotenv_block = '// Load environment variables\n' + DOTENV_LINE + '\n\n'
    moved_dotenv = mutate(expected, dotenv_block, '')
    moved_dotenv = mutate(moved_dotenv, '\n};\n', '\n};\n\n' + dotenv_block.rstrip('\n') + '\n')
    hoisted = mutate(mutate(expected, VALIDATOR, ''), dotenv_block, VALIDATOR + dotenv_block)
    auth = (ROOT / 'src1/modules/middleware/auth.ts').read_text()
    return [
        ('baseline_config', original, None, 'VALIDATOR_PRESENT'),
        ('literal_fallback_or', mutate(expected, NEW_INIT, "  JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY || 'dev-only-secret'),\n"),
         None, 'NO_LITERAL_FALLBACK'),
        ('literal_fallback_nullish', mutate(expected, NEW_INIT, "  JWT_SECRET_KEY: requireJwtSecret(process.env.JWT_SECRET_KEY ?? 'dev-only-secret'),\n"),
         None, 'NO_LITERAL_FALLBACK'),
        ('original_fallback_restored', mutate(expected, NEW_INIT, OLD_INIT), None, 'NO_LITERAL_FALLBACK'),
        ('production_only_gating',
         mutate(expected, body_if, "  if (process.env.NODE_ENV !== 'production') {\n    return value ?? '';\n  }\n" + body_if),
         None, 'UNCONDITIONAL'),
        ('placeholder_omitted_your_secret_key', mutate(expected, "['your-secret-key', ", "["), None, 'PLACEHOLDER_SET_EXACT'),
        ('placeholder_omitted_change_in_production',
         mutate(expected, ", 'your-secret-key-change-in-production']", ']'), None, 'PLACEHOLDER_SET_EXACT'),
        ('extra_placeholder_invented',
         mutate(expected, "'your-secret-key-change-in-production']", "'your-secret-key-change-in-production', 'secret']"),
         None, 'PLACEHOLDER_SET_EXACT'),
        ('whitespace_accepted', mutate(expected, "    value.trim() === '' ||\n", "    value === '' ||\n"), None, 'PRESENCE_CHECK'),
        ('presence_check_removed', mutate(expected, '    value === undefined ||\n', ''), None, 'PRESENCE_CHECK'),
        ('padded_placeholder_accepted', mutate(expected, 'includes(value.trim())', 'includes(value)'), None,
         'PLACEHOLDER_REJECTED'),
        ('valid_key_rejected', mutate(expected, "    value.trim() === '' ||\n", "    value.trim() !== '' ||\n"), None,
         'VALID_ACCEPTED'),
        ('case_folded_placeholder_policy', mutate(expected, 'includes(value.trim())', 'includes(value.trim().toLowerCase())'),
         None, 'VALID_ACCEPTED'),
        ('trimmed_value_returned', mutate(expected, '  return value;\n}', '  return value.trim();\n}'), None,
         'RAW_VALUE_RETURNED'),
        ('warn_instead_of_throw', mutate(expected, "    throw new Error('%s');" % MESSAGE, "    console.warn('%s');" % MESSAGE),
         None, 'THROWS_NOT_WARNS'),
        ('message_echoes_value', mutate(expected, "throw new Error('%s');" % MESSAGE, 'throw new Error(`JWT_SECRET_KEY rejected: ${value}`);'),
         None, 'FIXED_MESSAGE'),
        ('length_policy_invented', mutate(expected, '    value === undefined ||\n', '    value === undefined ||\n    value.length < 32 ||\n'),
         None, 'NO_STRENGTH_POLICY'),
        ('validation_moved_to_first_use',
         mutate(expected, NEW_INIT, '  get JWT_SECRET_KEY() {\n    return requireJwtSecret(process.env.JWT_SECRET_KEY);\n  },\n'),
         None, 'VALIDATED_AT_LOAD'),
        ('async_validator', mutate(expected, 'function requireJwtSecret(value: string | undefined): string {',
                                   'async function requireJwtSecret(value: string | undefined): Promise<string> {'),
         None, 'GUARD_SYNCHRONOUS'),
        ('validator_wrapped_in_load_time_try_catch',
         mutate(expected, NEW_INIT, '  JWT_SECRET_KEY: (() => {\n    try {\n      return requireJwtSecret(process.env.JWT_SECRET_KEY);\n'
                '    } catch {\n      return String(process.env.JWT_SECRET_KEY);\n    }\n  })(),\n'), None, 'NO_TRY_CATCH'),
        ('validator_hoisted_above_dotenv', hoisted, None, 'DOTENV_BEFORE_VALIDATION'),
        ('dotenv_moved_after_config', moved_dotenv, None, 'DOTENV_BEFORE_VALIDATION'),
        ('consumer_reads_env_directly', expected,
         {'src1/modules/middleware/auth.ts': mutate(auth, 'jwt.verify(token, CONFIG.JWT_SECRET_KEY)',
                                                    "jwt.verify(token, process.env.JWT_SECRET_KEY || '')")},
         'SINGLE_SECRET_SOURCE'),
    ]


def verify(negative_controls):
    original, expected = expected_source()
    if negative_controls:
        if semantic_failures(expected):
            raise AssertionError('Expected amendment fails semantics: %s' % semantic_failures(expected))
        results = []
        for name, candidate, overrides, want in controls(original, expected):
            outcome = check(candidate, expected, overrides)
            if outcome is None:
                raise AssertionError('Source negative accepted: ' + name)
            rejected_by, failures = outcome
            names = [first_check(f) for f in failures]
            if rejected_by == 'EXACT_TRANSFORM' or want not in names:
                raise AssertionError('Control %s not rejected by %s: %s' % (name, want, failures))
            results.append({'control': name, 'intended': want, 'rejected_by': rejected_by, 'semantic_failures': names})
        return {'status': 'SOURCE_NEGATIVES_REJECTED', 'control_count': len(results), 'controls': results,
                'exact_comparison_rejections': 0, 'typescript_evaluations': 0}
    outcome = check((ROOT / SOURCE).read_text(), expected) or tree_checks()
    if outcome:
        raise AssertionError(outcome[1][0])
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'source_sha256': hashlib.sha256(expected.encode()).hexdigest(), 'validator_sha256': VALIDATOR_SHA256,
            'binding_gate': 'EXACT_TRANSFORM + PROTECTED_PINS + DIFF_SCOPE; semantic checks are diagnostic',
            'pinned_files': len(PINNED), 'diff_scope': list(SCOPE), 'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--negative-controls', action='store_true')
    options = parser.parse_args()
    try:
        print(json.dumps(verify(options.negative_controls)))
    except AssertionError as failure:
        print(json.dumps({'status': 'REJECTED', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(1)

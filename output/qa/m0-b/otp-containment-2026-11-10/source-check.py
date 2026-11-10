"""Check the reviewed OTP amendment as text; never evaluate TypeScript."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[4]
BASELINE = '525d435332eb1ff0d904f7aac4996a32a74fe0ba'
SERVICE = 'src1/modules/otp/services/index.ts'
ROUTES = 'src1/routes/index.ts'
IMPORT = "import otpRouter from '@/modules/otp/routes';\n"
MOUNT = "  app.use('/api/v1/otp', otpRouter);\n"
LOOKUP = '''    const otpRecord = await this.otpRepository.findByUserIdAndOTP(
      data.userId,
      data.otp,
      data.target,
      data.targetValue
    );

'''


def git(*arguments):
    return subprocess.check_output(['git', *arguments], cwd=ROOT)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def expected_sources():
    original = git('show', BASELINE + ':' + SERVICE).decode()
    routes = git('show', BASELINE + ':' + ROUTES).decode()
    method = original.index('  async verifyOTP(')
    start = original.index('      // Allow default OTP', method)
    end = original.index('    if (!otpRecord)', start)
    expected = original[:start] + LOOKUP + original[end:]
    assert expected.count('!isValidOTP && ') == 2
    expected = expected.replace('!isValidOTP && ', '')
    expected = expected.replace('// Check expiry (skip for default OTP)', '// Check expiry')
    expected = expected.replace("// Verify the OTP matches (unless it's the default OTP)", '// Verify the OTP matches')
    assert routes.count(IMPORT) == routes.count(MOUNT) == 1
    return original, routes, expected, routes.replace(IMPORT, '').replace(MOUNT, '')


def check(service, routes, expected, expected_routes):
    method = service.split('  async verifyOTP(', 1)[1].split('  async getLatestOTP(', 1)[0]
    assert 'isValidOTP' not in method, 'Special-code selector or exemption remains'
    assert LOOKUP in service, 'Unconditional exact-code lookup changed'
    assert 'if (otpRecord.expireAt && otpRecord.expireAt < new Date()) {' in method, 'Expiry guard changed'
    assert 'if (otpRecord.otp !== data.otp) {' in method, 'Code-equality guard changed'
    assert service == expected, 'OTP service differs from minimal reviewed amendment'
    assert 'otpRouter' not in routes, 'Raw OTP router still imported or mounted'
    assert routes == expected_routes, 'Central routes differ from minimal reviewed withdrawal'


def verify(negatives):
    original, original_routes, expected, expected_routes = expected_sources()
    if negatives:
        cases = [
            ('original_fixed_code_service', original, expected_routes),
            ('target_only_lookup', expected.replace('findByUserIdAndOTP(', 'findByUserIdAndTarget('), expected_routes),
            ('expiry_exemption', expected.replace('if (otpRecord.expireAt &&', 'if (false && otpRecord.expireAt &&'), expected_routes),
            ('equality_exemption', expected.replace('if (otpRecord.otp !== data.otp)', 'if (false && otpRecord.otp !== data.otp)'), expected_routes),
            ('raw_import_restored', expected, IMPORT + expected_routes),
            ('raw_mount_restored', expected, expected_routes.replace("  app.use('/api/v1/auth', authRouterV1);\n", "  app.use('/api/v1/auth', authRouterV1);\n" + MOUNT)),
            ('original_public_raw_routes', expected, original_routes),
        ]
        rejected = []
        for name, service, routes in cases:
            try:
                check(service, routes, expected, expected_routes)
            except AssertionError:
                rejected.append(name)
            else:
                raise AssertionError('Source control was accepted: ' + name)
        return {'status': 'SOURCE_CONTROLS_REJECTED', 'controls': rejected, 'typescript_evaluations': 0}
    check((ROOT / SERVICE).read_text(), (ROOT / ROUTES).read_text(), expected, expected_routes)
    protected = ['src1/modules/auth/services/index.ts', 'src1/modules/auth/routes/index.ts',
                 'src1/modules/auth/validation/index.ts', 'src1/modules/otp/repository/index.ts',
                 'src1/modules/otp/model/index.ts', 'src1/modules/email/services/index.ts',
                 'package.json', 'package-lock.json', 'server.js', 'tsconfig.json',
                 'test/foundation/run.mjs', 'test/application/bootstrap.mjs']
    for name in protected:
        assert (ROOT / name).read_bytes() == git('show', BASELINE + ':' + name), 'Protected file changed: ' + name
    archive = ROOT / 'documentation/planning/implementation/handover/2026-11-10-local-extensions'
    for name, value in json.loads((archive / 'artifacts.sha256.json').read_text()).items():
        assert sha((archive / name).read_bytes()) == value, 'Archived artifact changed: ' + name
    frozen = json.loads((archive / 'review-input.json').read_text())
    for name, value in frozen['files_sha256'].items():
        assert sha((ROOT / name).read_bytes()) == value, 'Staged source changed: ' + name
    assert git('diff', '--cached', '--binary', '--full-index') == (archive / 'candidate.diff').read_bytes(), 'Staged patch changed'
    return {'status': 'SOURCE_ONLY_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASELINE,
            'service_sha256': sha(expected.encode()), 'routes_sha256': sha(expected_routes.encode()),
            'typescript_evaluations': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--negative-controls', action='store_true')
    options = parser.parse_args()
    try:
        print(json.dumps(verify(options.negative_controls)))
    except AssertionError as failure:
        print(json.dumps({'status': 'REJECTED', 'reason': str(failure), 'typescript_evaluations': 0}))
        raise SystemExit(1)

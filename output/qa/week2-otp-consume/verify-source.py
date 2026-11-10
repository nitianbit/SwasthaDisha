"""Verify a frozen source transformation; no TypeScript or application evaluation."""
import hashlib
import json
from pathlib import Path
import stat
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = '1b0a54144d514bd73f03a99724c8b0d02fcfa25a'
PREFIX = 'output/qa/week2-otp-consume/'
CONTRACT_SHA = '2dc40e1b6d40a735a030415e1ff96d3691c1a8ac29fbb86cda98c0b0f5162e3a'
REPO = 'src1/modules/otp/repository/index.ts'
SERVICE = 'src1/modules/otp/services/index.ts'
AUTH = 'src1/modules/auth/services/index.ts'
FROZEN = {
    REPO: '5f68f9616f26f9ed8ebe66354d90d5fb25e95c35f9a3f56bec8f6f1a7c4c1306',
    SERVICE: '7aa21a23b21b80a8b08f508de0df9b7f916dcf60bdaa7d0b7e9ce51b9897746e',
    AUTH: '58323c9324411ab48e69d06e4e84ed76e9e01690a9200ac416a937d9a6836390',
    'src1/modules/otp/types/index.ts': '7ee33890ffbbfeefb0921fec4faf53c0af775b963e90202199a542c642ac15fd',
    'src1/modules/otp/model/index.ts': '9891e0b34bbd3b21502540d86a8001c4f666223ddb8628c2922a1953ede6506d',
    'src1/modules/common/repository/BaseRepository.ts': '14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a',
    'src1/modules/auth/validation/index.ts': 'c0424a7bf6fb49226dec0aa39babec98221f50fcd842c4137120b8a30a3d3527',
    'src1/routes/index.ts': '50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056',
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', *args], cwd=ROOT)


def once(text, old, new):
    assert text.count(old) == 1, 'Unexpected replacement count: ' + old[:70]
    return text.replace(old, new, 1)


def expected():
    old = {}
    for path, digest in FROZEN.items():
        data = git('show', BASE + ':' + path)
        assert sha(data) == digest, 'Frozen baseline changed: ' + path
        old[path] = data.decode()
    repository = once(old[REPO], "import { IOTP } from '@/modules/otp/types';",
                      "import { IOTP, VerifyOTPRequest } from '@/modules/otp/types';")
    repository = once(repository, '''  markAsVerified = async (otpId: string): Promise<IOTP | null> => {
    return this.update({ _id: otpId }, { isVerified: true });
  };''', '''  markAsVerified = async (
    otpId: string,
    data: VerifyOTPRequest & { targetValue: string },
    observedExpiry: Date,
    consumeCheckpoint: Date
  ): Promise<IOTP | null> => {
    return this.update(
      {
        _id: otpId,
        userId: data.userId,
        otp: data.otp,
        target: data.target,
        targetValue: data.targetValue,
        isVerified: false,
        expireAt: { $eq: observedExpiry, $gt: consumeCheckpoint },
      },
      { $set: { isVerified: true } },
      { new: true }
    );
  };''')
    service = once(old[SERVICE],
                   '    if (otpRecord.expireAt && otpRecord.expireAt < new Date()) {',
                   '''    if (
      !(otpRecord.expireAt instanceof Date) ||
      !Number.isFinite(otpRecord.expireAt.getTime()) ||
      otpRecord.expireAt <= new Date()
    ) {''')
    service = once(service, '''    // Mark as verified
    const verifiedOTP = await this.otpRepository.markAsVerified(otpRecord._id!);''', '''    if (
      typeof otpRecord.targetValue !== 'string' ||
      otpRecord.targetValue.trim() === '' ||
      (data.targetValue !== undefined && data.targetValue !== otpRecord.targetValue)
    ) {
      throw new AppError({
        status: 400,
        code: 'OTP_UNAVAILABLE',
        message: 'OTP is no longer available; request a new OTP',
      });
    }

    const observedExpiry = new Date(otpRecord.expireAt.getTime());
    const verifiedOTP = await this.otpRepository.markAsVerified(
      otpRecord._id!,
      { ...data, targetValue: otpRecord.targetValue },
      observedExpiry,
      new Date()
    );''')
    service = once(service, '''        status: 500,
        code: 'VERIFICATION_FAILED',
        message: 'Failed to verify OTP',''', '''        status: 400,
        code: 'OTP_UNAVAILABLE',
        message: 'OTP is no longer available; request a new OTP',''')
    service = once(service, '''    return verifiedOTP;''', '''    if (
      !(verifiedOTP.expireAt instanceof Date) ||
      !Number.isFinite(verifiedOTP.expireAt.getTime()) ||
      verifiedOTP.expireAt <= new Date()
    ) {
      throw new AppError({
        status: 400,
        code: 'OTP_EXPIRED',
        message: 'OTP has expired',
      });
    }

    return verifiedOTP;''')
    auth = once(old[AUTH], '''    // Verify OTP using OTP service
    const target = data.phone ? 'phone' : 'email';
    await this.otpService.verifyOTP({
      userId: userRecord._id!,
      otp: data.otp,
      target,
    });''', '''    // Verify OTP against the selected identity's current destination.
    const target = data.phone ? 'phone' : 'email';
    const targetValue = target === 'phone'
      ? userRecord.phone?.trim()
      : userRecord.email?.trim().toLowerCase();
    if (!targetValue) {
      throw new AppError({
        status: 400,
        code: 'OTP_UNAVAILABLE',
        message: 'OTP is no longer available; request a new OTP',
      });
    }
    await this.otpService.verifyOTP({
      userId: userRecord._id!,
      otp: data.otp,
      target,
      targetValue,
    });''')
    return {REPO: repository.encode(), SERVICE: service.encode(), AUTH: auth.encode()}


def verify_bytes(actual, want):
    assert set(actual) == set(want), 'Production file set differs'
    for path in want:
        assert actual[path] == want[path], 'Exact reviewed transformation differs: ' + path


def controls(want):
    cases = []
    for label, old, new in [
        ('missing-id', '        _id: otpId,\n', ''),
        ('missing-user', '        userId: data.userId,\n', ''),
        ('missing-code', '        otp: data.otp,\n', ''),
        ('missing-target', '        target: data.target,\n', ''),
        ('missing-destination', '        targetValue: data.targetValue,\n', ''),
        ('missing-pending', '        isVerified: false,\n', ''),
        ('missing-exact-expiry', '$eq: observedExpiry, ', ''),
        ('missing-live-expiry', ', $gt: consumeCheckpoint', ''),
        ('returned-old-document', '      { new: true }', '      { new: false }'),
        ('wrong-transition', '{ $set: { isVerified: true } }', '{ $set: { isVerified: false } }'),
    ]:
        cases.append((label, REPO, once(want[REPO].decode(), old, new)))
    for label, old, new in [
        ('truthy-provided-value', 'data.targetValue !== undefined &&', 'data.targetValue &&'),
        ('loose-destination', 'data.targetValue !== otpRecord.targetValue', 'data.targetValue != otpRecord.targetValue'),
        ('missing-bound-value', "      typeof otpRecord.targetValue !== 'string' ||\n", ''),
        ('allow-blank-destination', "      otpRecord.targetValue.trim() === '' ||\n", ''),
        ('expiry-not-snapshotted', 'const observedExpiry = new Date(otpRecord.expireAt.getTime());', 'const observedExpiry = otpRecord.expireAt;'),
        ('expired-at-equality', '      verifiedOTP.expireAt <= new Date()', '      verifiedOTP.expireAt < new Date()'),
        ('postcheck-disabled', '      !(verifiedOTP.expireAt instanceof Date) ||', '      false ||'),
        ('nonfinite-post-expiry', '      !Number.isFinite(verifiedOTP.expireAt.getTime()) ||\n', ''),
        ('stale-final-checkpoint', '      verifiedOTP.expireAt <= new Date()', '      verifiedOTP.expireAt <= observedExpiry'),
        ('old-infrastructure-error', "        code: 'OTP_UNAVAILABLE',\n        message: 'OTP is no longer available; request a new OTP',\n      });\n    }\n\n    if (", "        code: 'VERIFICATION_FAILED',\n        message: 'Failed to verify OTP',\n      });\n    }\n\n    if ("),
    ]:
        cases.append((label, SERVICE, once(want[SERVICE].decode(), old, new)))
    for label, old, new in [
        ('request-phone-binding', '      ? userRecord.phone?.trim()', '      ? data.phone?.trim()'),
        ('request-email-binding', '      : userRecord.email?.trim().toLowerCase();', '      : data.email?.trim().toLowerCase();'),
        ('wrong-selection-precedence', "    const targetValue = target === 'phone'", "    const targetValue = target === 'email'"),
        ('no-login-destination', '      target,\n      targetValue,\n    });', '      target,\n    });'),
        ('unawaited-consumption', '    await this.otpService.verifyOTP({', '    this.otpService.verifyOTP({'),
    ]:
        # Limit mutations to login, leaving the unchanged email callers intact.
        text = want[AUTH].decode()
        start = text.index("    // Verify OTP against the selected identity's current destination.")
        end = text.index('    // Create wallet for regular users', start)
        section = text[start:end]
        modified = text[:start] + once(section, old, new) + text[end:]
        cases.append((label, AUTH, modified))
    results = []
    for label, path, value in cases:
        mutant = dict(want); mutant[path] = value.encode()
        try:
            verify_bytes(mutant, want)
        except AssertionError:
            results.append({'name': label, 'result': 'REJECTED_AS_EXPECTED'})
        else:
            raise AssertionError('Source control survived: ' + label)
    return results


def verify():
    want = expected()
    assert sha((ROOT / PREFIX / 'CONTRACT.md').read_bytes()) == CONTRACT_SHA, 'Unreviewed contract'
    for path, digest in FROZEN.items():
        if path not in want:
            assert sha((ROOT / path).read_bytes()) == digest, 'Frozen input changed: ' + path
    original = {path: git('show', BASE + ':' + path) for path in want}
    try:
        verify_bytes(original, want)
    except AssertionError:
        before = 'REJECTED_AS_EXPECTED'
    else:
        raise AssertionError('Unprotected baseline accepted')
    actual = {}
    for path in want:
        p = ROOT / path; mode = p.lstat().st_mode
        assert stat.S_ISREG(mode) and not mode & 0o111, 'Unexpected source file type/mode'
        actual[path] = p.read_bytes()
    verify_bytes(actual, want)
    paths = git('diff', '--no-renames', '--name-only', BASE, '--').decode().splitlines()
    paths += git('ls-files', '--others').decode().splitlines()
    for path in paths:
        assert path in want or path.startswith(PREFIX), 'Outside owned scope: ' + path
    return {'status': 'SOURCE_TRANSFORMATION_VERIFIED_RUNTIME_NOT_RUN', 'baseline': BASE,
            'baseline_rejection': before,
            'production_sha256': {path: sha(data) for path, data in actual.items()},
            'contract_sha256': CONTRACT_SHA, 'verifier_sha256': sha(Path(__file__).read_bytes()),
            'source_controls': controls(want), 'TypeScript_evaluations': 0,
            'runtime_cases': 'NOT_RUN_PENDING_C2_C3_PROFILE_AND_FIXTURE'}


if __name__ == '__main__':
    print(json.dumps(verify(), indent=2))

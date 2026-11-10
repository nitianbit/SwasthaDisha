#!/usr/bin/env python3
"""Source-data binding only. Never imports/evaluates TypeScript or app code."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
BASE = 'eba7e5c82e3ff63af9e9a958fbd100733e1fc439'
SOURCE = 'src1/modules/wallet/controller/index.ts'
EVIDENCE = 'output/qa/batch3-wallet-reads/'
CONTRACT_SHA = '1b87df138ddc5038a53678f316c947503630c020423e1d4bb571cd61b32ab727'
BASE_SHA = '16c44f56c7c3962af0d70dbb01ad6e2fe0b174df612e58764948364454245471'
PINS = {
    'src1/modules/wallet/routes/index.ts': '5ce3fc7bdd72140348df94787b0c4e47a19190ada5137a2971be84cbe584197c',
    'src1/modules/wallet/services/index.ts': '938433ca68e0481bf86d2b69f5d56106fba04f913c94e326947bbd617fbc13ff',
    'src1/modules/wallet/model/index.ts': '18757f38145a2ebab378cd1d00c423170a00fd3b136b1229105244fb1a540538',
    'src1/modules/wallet/types/index.ts': 'ebe4c82783a032315ff70df33961010ab44ff11413bb29c3cd98e7d0f43e0e6b',
    'src1/modules/wallet/repository/index.ts': '4db66107afa4ecb7db99a91c3d9216488a514145187e56bc0d589677e344b726',
    'src1/modules/common/repository/BaseRepository.ts': '14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a',
    'src1/modules/wallet/validation/index.ts': 'b14fcba5a716314998d755b16d27db8a43e45e1244fc327543c90f7db41356d1',
    'src1/modules/common/middleware/validation.ts': '8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef',
    'src1/modules/middleware/errorHandler.ts': '1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51',
    'src1/modules/common/utils/asyncHandler.ts': '59fe49db58678ef81242a654f7457f74b067b2583a3f8dc70918b61f50228bd9',
    'src1/modules/middleware/auth.ts': 'db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2',
    'src1/config/config.ts': 'e879b0f9c635283d7c9a271128605c6d8583995356e30f5f1c318d23270d09f6',
    'src1/routes/index.ts': '50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056',
}
IDENTITY = """    if (typeof req.user?._id !== 'string' || req.user._id.length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

"""
OWNER = """
    if (req.user.userType !== 'admin' && result.userId !== req.user._id) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to another wallet is not permitted',
      });
    }
"""


def git(*args):
    return subprocess.check_output(
        ['/usr/bin/git', '-c', 'core.fsmonitor=false', *args], cwd=ROOT)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def region(text, name):
    marker = f'  {name} = async ('
    if text.count(marker) != 1:
        raise ValueError(f'{name}:unique_method')
    start = text.index(marker)
    return text[start:text.index('\n  };', start) + len('\n  };')]


def expected_source(baseline):
    anchor = "import { AuthRequest } from '@/modules/middleware/auth';\n"
    assert baseline.count(anchor) == 1
    text = baseline.replace(anchor, anchor + "import { AppError } from '@/modules/common/types';\n")
    for name in ('getById', 'getTransactionById'):
        original = region(text, name)
        amended = original.replace('req: Request', 'req: AuthRequest', 1)
        anchor = '    const { id } = req.params;\n'
        assert amended.count(anchor) == 1
        amended = amended.replace(anchor, IDENTITY + anchor, 1)
        anchor = f'    const result = await this.walletService.{name}(id);\n'
        assert amended.count(anchor) == 1
        amended = amended.replace(anchor, anchor + OWNER, 1)
        text = text.replace(original, amended, 1)
    return text


def rejection(text, expected):
    """Named substring diagnostics are not behavioral proofs; exact bytes bind."""
    if "import { AppError } from '@/modules/common/types';" not in text:
        return 'required_import'
    for name in ('getById', 'getTransactionById'):
        try:
            part = region(text, name)
        except ValueError as error:
            return str(error)
        if 'req: AuthRequest' not in part:
            return f'{name}:auth_request'
        if part.count(IDENTITY) != 1:
            return f'{name}:principal_guard'
        lookup = f'    const result = await this.walletService.{name}(id);\n'
        if part.count(lookup) != 1 or part.count('this.walletService.') != 1:
            return f'{name}:one_authoritative_lookup'
        if part.count(OWNER) != 1:
            return f'{name}:stored_owner_or_exact_admin'
        response = '    res.status(200).json({'
        if (part.count(response) != 1 or
                not part.index(IDENTITY) < part.index(lookup) < part.index(OWNER) < part.index(response)):
            return f'{name}:guard_order'
        if 'req.body' in part or 'req.query' in part:
            return f'{name}:request_owner_forbidden'
    if text != expected:
        return 'exact_transform'
    return None


def scope_rejection(paths):
    unexpected = [p for p in paths if p != SOURCE and not p.startswith(EVIDENCE)]
    return 'single_controller_and_owned_evidence_scope' if unexpected else None


def pin_rejection(actual):
    return 'pinned_contract_inputs' if actual != PINS else None


def source_controls(expected, baseline):
    variants = [('original_baseline', baseline)]
    for name in ('getById', 'getTransactionById'):
        part = region(expected, name)
        lookup = f'    const result = await this.walletService.{name}(id);\n'
        changed = {
            'missing_principal_check': part.replace(IDENTITY, ''),
            'principal_check_after_fetch': part.replace(IDENTITY, '').replace(lookup, lookup + IDENTITY),
            'missing_owner_check': part.replace(OWNER, ''),
            'owner_check_after_response': part.replace(OWNER, '') + OWNER,
            'owner_from_path': part.replace('result.userId !==', 'req.params.id !=='),
            'owner_from_query': part.replace('result.userId !==', 'req.query.userId !=='),
            'loose_owner_equality': part.replace('result.userId !==', 'result.userId !='),
            'admin_overblocked': part.replace("req.user.userType !== 'admin' && ", ''),
            'hr_bypass': part.replace("req.user.userType !== 'admin'", "req.user.userType !== 'hr'"),
            'extra_wallet_lookup': part.replace(lookup, lookup + '    await this.walletService.getByUserId(req.user._id);\n'),
        }
        for label, changed_part in changed.items():
            variants.append((f'{name}:{label}', expected.replace(part, changed_part, 1)))
    variants.append(('outside_approved_methods', expected + '\n// changed module surface\n'))
    receipts = []
    for label, variant in variants:
        reason = rejection(variant, expected)
        if not reason:
            raise AssertionError(f'control_survived:{label}')
        receipts.append({'control': label, 'rejected_by': reason})
    return receipts


def main():
    baseline_bytes = git('show', f'{BASE}:{SOURCE}')
    assert digest(baseline_bytes) == BASE_SHA, 'baseline_hash'
    assert digest((ROOT / EVIDENCE / 'CONTRACT.md').read_bytes()) == CONTRACT_SHA, 'contract_hash'
    baseline = baseline_bytes.decode('utf-8')
    expected = expected_source(baseline)
    current_bytes = (ROOT / SOURCE).read_bytes()
    reason = rejection(current_bytes.decode('utf-8'), expected)
    actual_pins = {path: digest((ROOT / path).read_bytes()) for path in PINS}
    assert not pin_rejection(actual_pins), 'pinned_contract_inputs'
    changed = git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', BASE, '--').decode().splitlines()
    untracked = git('ls-files', '--others', '--exclude-standard').decode().splitlines()
    assert not scope_rejection(changed + untracked), 'single_controller_and_owned_evidence_scope'
    assert all(not (ROOT / path).is_symlink() for path in [SOURCE, *PINS]), 'no_symlinked_inputs'
    controls = source_controls(expected, baseline)
    structural = []
    for label, paths in [
        ('sibling_production_edit', [SOURCE, 'src1/modules/wallet/services/index.ts']),
        ('untracked_production_file', [SOURCE, 'src1/modules/wallet/controller/bypass.ts']),
    ]:
        rejected_by = scope_rejection(paths)
        assert rejected_by
        structural.append({'control': label, 'rejected_by': rejected_by})
    for name in ['src1/modules/wallet/repository/index.ts', 'src1/modules/wallet/types/index.ts', 'src1/modules/wallet/validation/index.ts']:
        changed_pins = dict(actual_pins)
        changed_pins[name] = '0' * 64
        rejected_by = pin_rejection(changed_pins)
        assert rejected_by
        structural.append({'control': name, 'rejected_by': rejected_by})
    result = {
        'boundary': 'PYTHON_SOURCE_DATA_ONLY_NOT_RUNTIME_ACCEPTANCE',
        'baseline_commit': BASE,
        'baseline_controller_sha256': BASE_SHA,
        'controller_sha256': digest(current_bytes),
        'expected_controller_sha256': digest(expected.encode('utf-8')),
        'contract_sha256': CONTRACT_SHA,
        'accepted': reason is None,
        'rejection': reason,
        'source_controls': controls,
        'structural_controls': structural,
        'pinned_input_sha256': actual_pins,
        'tracked_changed_paths': changed,
        'untracked_paths': untracked,
        'application_runtime': 'NOT_RUN',
    }
    print(json.dumps(result, indent=2))
    return int(reason is not None)


if __name__ == '__main__':
    sys.exit(main())

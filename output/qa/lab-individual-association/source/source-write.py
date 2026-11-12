from pathlib import Path
import difflib
import hashlib
import json
import re
import shutil

ROOT = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
OUT = ROOT/'output/qa/lab-individual-association/source'
CONTROLLER = 'src1/modules/externalBookings/controller/index.ts'
CONTRACT = 'documentation/planning/implementation/LAB_INDIVIDUAL_ASSOCIATION_CONTRACT_DRAFT.md'
CONTRACT_SHA = '79e5ec32ea34a30b3859676f1297b8553e81add2f314ea214d9bbe0e3cfd7a05'
BASELINE_SHA = '67ebcef4ec0b7f21c9bf2c9c274a6d6066499ef34f0637fa3fa0ee36fde2acd3'
OLD = ': req.user?.corporateId || (req.body.corporateId as string | undefined),'
NEW = ': req.user?.corporateId,'
sha = lambda data: hashlib.sha256(data).hexdigest()

def main():
    assert not OUT.exists(), 'Do not overwrite source evidence'
    original = (ROOT/CONTROLLER).read_bytes()
    assert sha(original) == BASELINE_SHA, 'Controller baseline drift'
    contract = (ROOT/CONTRACT).read_bytes()
    assert sha(contract) == CONTRACT_SHA, 'Contract drift'
    bound = re.findall(r'\| `([^`]+)` \| `([0-9a-f]{64})` \|', contract.decode())
    assert len(bound) == 9, 'Expected nine contract source bindings'
    for name, expected in bound:
        assert sha((ROOT/name).read_bytes()) == expected, 'Contract source pin drift: ' + name
    approval = (ROOT/'output/qa/lab-individual-association/PREIMPLEMENTATION.json').read_bytes()
    approved = json.loads(approval)
    assert approved['contractSha256'] == CONTRACT_SHA
    assert approved['controllerBaselineSha256'] == BASELINE_SHA
    assert approved['rootAction'] == 'AUTHORIZE_EXACT_TWO_EXPRESSION_REMOVAL_ONLY'
    assert approved['runtimeApproved'] is False
    assert {(d['reviewer'], d['role'], d['decision']) for d in approved['decisions']} == {
        ('/root/booking_read_spec', 'Spec', 'APPROVE_IMPLEMENTATION_ONLY'),
        ('/root', 'Standards', 'APPROVE_IMPLEMENTATION_ONLY'),
    }, 'Missing actual bounded approval'
    paths = [p for parent in ('src1', 'test/foundation', 'output/qa/customer-booking-read') for p in (ROOT/parent).rglob('*') if p.is_file()]
    paths += [ROOT/name for name in ('package.json', 'package-lock.json', 'tsconfig.json', 'server.js') if (ROOT/name).is_file()]
    assert all(not p.is_symlink() for p in paths), 'Unexpected symlink in protected file inventory'
    pins = {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(paths)}
    before = original.decode()
    assert before.count(OLD) == 2, 'Two exact original expressions required'
    candidate = before.replace(OLD, NEW)
    OUT.mkdir()
    (OUT/'controller.before.ts.txt').write_bytes(original)
    (OUT/'controller.expected.ts.txt').write_text(candidate)
    (OUT/'preimplementation.snapshot.json').write_bytes(approval)
    (OUT/'protected-files.before.json').write_text(json.dumps(pins, indent=2)+'\n')
    shutil.copyfile('/private/tmp/lab-association-source-check.py', OUT/'source-check.py')
    shutil.copyfile('/private/tmp/lab-association-source-write.py', OUT/'source-write.py')
    (ROOT/CONTROLLER).write_text(candidate)
    (OUT/'controller.after.ts.txt').write_bytes((ROOT/CONTROLLER).read_bytes())
    (OUT/'controller.diff').write_text(''.join(difflib.unified_diff(before.splitlines(keepends=True), candidate.splitlines(keepends=True), fromfile='a/'+CONTROLLER, tofile='b/'+CONTROLLER)))
    receipt = {'kind':'SOURCE_DATA_ONLY', 'baselineSha256':BASELINE_SHA, 'candidateSha256':sha(candidate.encode()), 'contractSha256':CONTRACT_SHA, 'contractSourcePinsRechecked':len(bound), 'protectedFileCount':len(pins), 'exactFallbackRemovals':2, 'runtimeBehavior':'NOT_RUN', 'gitMutation':False}
    (OUT/'write-receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt))

main()

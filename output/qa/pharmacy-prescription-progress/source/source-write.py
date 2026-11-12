from pathlib import Path
import hashlib,json,re,difflib,shutil
ROOT=Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/pharmacy-prescription-progress')
OUT=ROOT/'output/qa/pharmacy-prescription-progress/source'
AUTH=ROOT/'output/qa/pharmacy-prescription-progress/ROOT_AUTHORIZATION.json'
TARGET='src1/modules/pharmacyOrders/services/index.ts'
CONTRACT='documentation/planning/implementation/PHARMACY_PRESCRIPTION_PROGRESS_CONTRACT_DRAFT.md'
CONTRACT_SHA='136041731cdc1a10c3263842d2c12dedcdeeedd850249a0770581746fe7fd53a'
BASELINE_SHA='54bbff59b46586120f107472265d116a6754782aea6d632295ecea88983f5ddc'
BASE='2f27b59c183892b5418dfd8751d23890b9022c63'
MESSAGE='Authorize the exact prescription-progress SOURCE edit now in NEW isolated worktree /Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/pharmacy-prescription-progress, branch m0/pharmacy-prescription-progress, base2f27b59c183892b5418dfd8751d23890b9022c63. Your draft136041731cdc1a10c3263842d2c12dedcdeeedd850249a0770581746fe7fd53a and baseline54bbff59 are exact. Both independent Spec and Standards APPROVE_IMPLEMENTATION_ONLY are recorded in output/qa/pharmacy-prescription-progress/PREIMPLEMENTATION.json. They explicitly confirm existing design already authorizes this necessary gate; named-owner decisions are required before additional approval/recovery/money/stock policy code and before Rx enablement/release, not this bounded source edit. The owner names question is pending; infer no answer/approval. Own ONLY pharmacyOrders/services/index.ts plus its QA authorization/source evidence. Implement one private four-status list and one boolean after payment checks, reuse it in the existing guard and exact observed-state CAS; preserve every other byte/behavior specified. No new policy, helper/framework, refund, transition or clinical command. Source/text-data checks only; no Node/TS/app/DB/provider/network/model calls or Git changes. Freeze for two fresh nonauthor source reviews. F1 remains HIGH/open, legacy recovery unresolved. You are not alone: do not edit focus/lab/pure worktrees; preserve originals, other edits, six staged files and archive. Root commits/merges.'
LIST="""const PRESCRIPTION_GATED_STATUSES: OrderStatus[] = [
  'packed',
  'ready_for_pickup',
  'out_for_delivery',
  'completed',
];
"""
BOOLEAN='    const requiresPrescriptionCheck = PRESCRIPTION_GATED_STATUSES.includes(payload.status);\n'
sha=lambda data:hashlib.sha256(data).hexdigest()

def main():
    assert not OUT.exists() and not AUTH.exists(),'Never overwrite evidence or authorization'
    old=(ROOT/TARGET).read_bytes()
    assert sha(old)==BASELINE_SHA,'Service baseline drift'
    contract=(ROOT/CONTRACT).read_bytes()
    assert sha(contract)==CONTRACT_SHA,'Contract drift'
    bindings=re.findall(r'\| `([^`]+)` \| `([0-9a-f]{64})` \|',contract.decode())
    assert len(bindings)==28,'Unexpected contract pin count'
    for name,digest in bindings:
        assert sha((ROOT/name).read_bytes())==digest,'Contract binding drift: '+name
    decision_bytes=(ROOT/'output/qa/pharmacy-prescription-progress/PREIMPLEMENTATION.json').read_bytes()
    decisions=json.loads(decision_bytes)
    assert decisions['contractSha256']==CONTRACT_SHA and decisions['baselineSha256']==BASELINE_SHA
    assert decisions['rootDecision']=='AUTHORIZE_BOUNDED_SOURCE_IMPLEMENTATION_IN_ISOLATED_BRANCH'
    assert decisions['runtimeOrEnablementApproved'] is False
    assert {(d['agent'],d['role'],d['decision']) for d in decisions['reviewers']}=={
        ('/root/booking_read_spec','Spec','APPROVE_IMPLEMENTATION_ONLY'),
        ('/root/claude_review_recipe_standards','Standards','APPROVE_IMPLEMENTATION_ONLY')}
    parents=('src1','test/foundation','output/qa/customer-booking-read','output/qa/customer-booking-write-owner','output/qa/lab-individual-association','output/qa/lab-dependent-ownership','output/qa/pharmacy-prescription-consumption')
    paths=[p for parent in parents for p in (ROOT/parent).rglob('*') if p.is_file()]
    paths += [ROOT/name for name,_ in bindings]
    paths += [ROOT/name for name in ('package.json','package-lock.json','tsconfig.json','server.js') if (ROOT/name).is_file()]
    assert all(not p.is_symlink() for p in paths)
    pins={str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(set(paths))}
    assert sum(name.startswith('src1/') for name in pins)==358,'Application source inventory drift'
    before=old.decode()
    anchor='const UNPAID_ORDER_ABANDON_WINDOW_MS ='
    guard="""    if (
      payload.status === 'completed' &&
      order.prescriptionStatus !== 'approved' &&
"""
    cas="...(payload.status === 'completed'\n            ? { prescriptionStatus: order.prescriptionStatus }"
    assert before.count(anchor)==1 and before.count(guard)==1 and before.count(cas)==1,'Expected source anchors not unique'
    candidate=before.replace(anchor,LIST+anchor,1)
    candidate=candidate.replace(guard,BOOLEAN+guard.replace("payload.status === 'completed'",'requiresPrescriptionCheck',1),1)
    candidate=candidate.replace(cas,cas.replace("payload.status === 'completed'",'requiresPrescriptionCheck',1),1)
    OUT.mkdir()
    (OUT/'service.before.ts.txt').write_bytes(old)
    (OUT/'service.expected.ts.txt').write_text(candidate)
    (OUT/'protected-files.before.json').write_text(json.dumps(pins,indent=2)+'\n')
    (OUT/'preimplementation.snapshot.json').write_bytes(decision_bytes)
    shutil.copyfile('/private/tmp/pharmacy-progress-source-check.py',OUT/'source-check.py')
    shutil.copyfile('/private/tmp/pharmacy-progress-source-write.py',OUT/'source-write.py')
    authorization={'schema':'SD-PHARMACY-PROGRESS-ROOT-AUTHORIZATION-1','recordedBy':'/root/customer_booking_writer','authorizingAgent':'/root','provenance':'ACTUAL_NATIVE_NEW_TASK_MESSAGE','actualMessage':MESSAGE,'worktree':str(ROOT),'branch':'m0/pharmacy-prescription-progress','base':BASE,'contractSha256':CONTRACT_SHA,'baselineSha256':BASELINE_SHA,'authorizedProductionFiles':[TARGET],'boundedSourceEditAuthorized':True,'additionalClinicalRecoveryMoneyStockPolicyAuthorized':False,'runtimeOrRxEnablementOrReleaseApproved':False,'ownerNamesQuestion':'PENDING; no answer or approval inferred','F1':'HIGH_OPEN','otherWorktrees':'No author writes to focus, lab, pure or original worktrees; Root alone commits/merges.'}
    AUTH.write_text(json.dumps(authorization,indent=2)+'\n')
    (ROOT/TARGET).write_text(candidate)
    (OUT/'service.after.ts.txt').write_bytes((ROOT/TARGET).read_bytes())
    (OUT/'service.diff').write_text(''.join(difflib.unified_diff(before.splitlines(keepends=True),candidate.splitlines(keepends=True),fromfile='a/'+TARGET,tofile='b/'+TARGET)))
    receipt={'kind':'SOURCE_DATA_ONLY','worktree':str(ROOT),'base':BASE,'baselineSha256':BASELINE_SHA,'candidateSha256':sha(candidate.encode()),'contractSha256':CONTRACT_SHA,'contractSourcePinsRechecked':len(bindings),'protectedFileCount':len(pins),'appSourceFileCount':358,'rootAuthorizationSha256':sha(AUTH.read_bytes()),'runtimeBehavior':'NOT_RUN','F1':'HIGH_OPEN','gitMutation':False}
    (OUT/'write-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))

main()

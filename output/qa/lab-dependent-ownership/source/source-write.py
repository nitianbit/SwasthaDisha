from pathlib import Path
import hashlib,json,re,difflib,shutil
ROOT=Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/lab-dependent-ownership')
FOCUS=Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
OUT=ROOT/'output/qa/lab-dependent-ownership/source'
AUTH=ROOT/'output/qa/lab-dependent-ownership/ROOT_AUTHORIZATION.json'
TARGET='src1/modules/externalBookings/controller/index.ts'
CONTRACT='documentation/planning/implementation/LAB_DEPENDENT_OWNERSHIP_CONTRACT_DRAFT.md'
BASE='7438f449351bd8cb435142b017406cf05d23b3b2'
CONTRACT_SHA='8bfccbdd4baaf64a59e0c2d6a6d019b03cba38c18aa7d23a4845ba9ad3aa3d97'
BASELINE_SHA='b036cc91db6abf4cecfc2963fa02ab04b12bd8c8048c7c979468080a778942ce'
MESSAGE='Authorize labdependent implementation NOW ONLY in NEW isolatedworktree /Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/lab-dependent-ownership branchm0/lab-dependent-ownership base7438f449351bd8cb435142b017406cf05d23b3b2. Rootcreated/checkouted; ALLapp/design/contractbytes matchreviewedfocusbaseline. OriginalfocusworktreeACTIVE R4 muststayunchanged. Twoactualnonauthorpredecisions RootStandards+booking_read_specSpec recordedQA/lab-dependent-ownership/PREIMPLEMENTATION.json (oldfalseauthhistoricalpreserve). SnapshotdependencyRESOLVEDBYISOLATEDWORKTREE; don\'teditfocus, don\'tmerge/commit yourself. Own ONLY newworktree src1/modules/externalBookings/controller/index.ts and output/qa/lab-dependent-ownership/ROOT_AUTHORIZATION.json+source evidence. Exactcontract8bfccbdd4baaf64a59e0c2d6a6d019b03cba38c18aa7d23a4845ba9ad3aa3d97 /ctrlbaselineb036cc91db6abf4cecfc2963fa02ab04b12bd8c8048c7c979468080a778942ce. OneDependentServicefield/import/Container.get +oneawaitedguardfirstineachcreate, reusedgetById(id,signedowner), actor401/localmalformed/fixed404, noownedinactive/consentpolicy/demographics/servicechanges, preserveallothercontrollerbytes andsharedsource. Record actualRootauthorizationinclnewpath/base/snapshotisolation. Source-data checks/diff/hash/meaningfulnegativelexicalcontrols only; no applicationimports/TS/Nodeexec/runtime/DB/providers. Stopfrozenfor2freshindependentsourcereviews; RootcommitsandmergesAFTERR4completion. Youarenotalone preserveotheragents/originalsixstaged/archive. Escalatedsiblingwritesauthorized. Keepminimal andproportionate, noframework.'
sha=lambda data:hashlib.sha256(data).hexdigest()

def main():
    assert not OUT.exists() and not AUTH.exists(),'Never overwrite evidence/authorization'
    old=(ROOT/TARGET).read_bytes()
    assert sha(old)==BASELINE_SHA,'Isolated controller baseline drift'
    contract=(ROOT/CONTRACT).read_bytes()
    assert sha(contract)==CONTRACT_SHA,'Contract drift'
    bindings=re.findall(r'\| `([^`]+)` \| `([0-9a-f]{64})` \|',contract.decode())
    assert len(bindings)==28,'Unexpected contract binding count'
    for name,digest in bindings:
        assert sha((ROOT/name).read_bytes())==digest,'Contract source/design drift: '+name
    approval=(ROOT/'output/qa/lab-dependent-ownership/PREIMPLEMENTATION.json').read_bytes()
    reviewed=json.loads(approval)
    assert reviewed['contractSha256']==CONTRACT_SHA and reviewed['controllerBaselineSha256']==BASELINE_SHA
    assert reviewed['applicationEditAuthorizedNow'] is False,'Reconcile changed preimplementation record'
    assert {(d['agent'],d['role'],d['decision']) for d in reviewed['reviewers']}=={
        ('/root/booking_read_spec','Spec','APPROVE_IMPLEMENTATION_ONLY'),('/root','Standards','APPROVE_IMPLEMENTATION_ONLY')}
    parents=('src1','test/foundation','output/qa/customer-booking-read','output/qa/lab-individual-association','output/qa/customer-booking-write-owner','output/qa/pharmacy-prescription-consumption')
    paths=[p for parent in parents for p in (ROOT/parent).rglob('*') if p.is_file()]
    paths += [ROOT/name for name,_ in bindings]
    paths += [ROOT/name for name in ('package.json','package-lock.json','tsconfig.json','server.js') if (ROOT/name).is_file()]
    assert all(not p.is_symlink() for p in paths)
    pins={str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(set(paths))}
    assert sum(name.startswith('src1/') for name in pins)==358,'Application source inventory drift'
    focus={'root':str(FOCUS),'files':{str(p.relative_to(FOCUS)):sha(p.read_bytes()) for p in sorted((FOCUS/'src1').rglob('*')) if p.is_file()}}
    assert focus['files'][TARGET]==BASELINE_SHA,'Active R4 focus source drift before isolated edit'
    helper="""  private async assertCustomerDependentOwner(req: AuthRequest): Promise<void> {
    const actor = req.user;
    if (actor?.userType !== 'user') {
      return;
    }

    if (typeof actor._id !== 'string' || actor._id.trim().length === 0) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    const dependentId = req.body.dependentId;
    if (dependentId === undefined) {
      return;
    }

    if (
      typeof dependentId !== 'string' ||
      !/^[0-9a-fA-F]{24}$/.test(dependentId)
    ) {
      throw new AppError({
        status: 404,
        code: 'DEPENDENT_NOT_FOUND',
        message: 'Dependent not found',
      });
    }

    await this.dependentService.getById(dependentId, actor._id);
  }

"""
    text=old.decode()
    amendments=(
        ("import { AuthRequest } from '@/modules/middleware/auth';\n","import { AuthRequest } from '@/modules/middleware/auth';\nimport { AppError } from '@/modules/common/types';\n"),
        ("import { ExternalBookingService } from '@/modules/externalBookings/services';\n","import { ExternalBookingService } from '@/modules/externalBookings/services';\nimport { DependentService } from '@/modules/dependents/services';\n"),
        ('  private externalBookingService: ExternalBookingService;\n','  private externalBookingService: ExternalBookingService;\n  private dependentService: DependentService;\n'),
        ('    this.externalBookingService = Container.get(ExternalBookingService);\n','    this.externalBookingService = Container.get(ExternalBookingService);\n    this.dependentService = Container.get(DependentService);\n'),
        ('  private resolveIntegration',helper+'  private resolveIntegration'),
    )
    for before,after in amendments:
        assert text.count(before)==1,'Baseline amendment anchor not unique'
        text=text.replace(before,after,1)
    for name in ('createBooking','createDiagnosticsBooking'):
        header='  '+name+' = async (\n    req: AuthRequest,\n    res: Response,\n    _next: NextFunction\n  ) => {\n'
        assert text.count(header)==1,'Create header drift'
        text=text.replace(header,header+'    await this.assertCustomerDependentOwner(req);\n',1)
    OUT.mkdir()
    (OUT/'controller.before.ts.txt').write_bytes(old)
    (OUT/'controller.expected.ts.txt').write_text(text)
    (OUT/'protected-files.before.json').write_text(json.dumps(pins,indent=2)+'\n')
    (OUT/'focus-source.before.json').write_text(json.dumps(focus,indent=2)+'\n')
    (OUT/'preimplementation.snapshot.json').write_bytes(approval)
    shutil.copyfile('/private/tmp/lab-dependent-source-check.py',OUT/'source-check.py')
    shutil.copyfile('/private/tmp/lab-dependent-source-write.py',OUT/'source-write.py')
    authorization={'schema':'SD-LAB-DEPENDENT-ISOLATED-ROOT-AUTHORIZATION-1','recordedBy':'/root/customer_booking_writer','authorizingAgent':'/root','provenance':'ACTUAL_NATIVE_NEW_TASK_MESSAGE','actualMessage':MESSAGE,'worktree':str(ROOT),'branch':'m0/lab-dependent-ownership','base':BASE,'protectedActiveFocusWorktree':str(FOCUS),'snapshotDependency':'RESOLVED_BY_ISOLATED_WORKTREE; focus R4 remains active and unchanged. Root commits/merges only after R4 completion.','contractSha256':CONTRACT_SHA,'controllerBaselineSha256':BASELINE_SHA,'applicationEditAuthorizedNow':True,'priorFalseAuthorizationPreserved':True,'runtimeAdmission':False,'moduleAcceptance':False}
    AUTH.write_text(json.dumps(authorization,indent=2)+'\n')
    (ROOT/TARGET).write_text(text)
    (OUT/'controller.after.ts.txt').write_bytes((ROOT/TARGET).read_bytes())
    (OUT/'controller.diff').write_text(''.join(difflib.unified_diff(old.decode().splitlines(keepends=True),text.splitlines(keepends=True),fromfile='a/'+TARGET,tofile='b/'+TARGET)))
    receipt={'kind':'SOURCE_DATA_ONLY','worktree':str(ROOT),'base':BASE,'baselineSha256':BASELINE_SHA,'candidateSha256':sha(text.encode()),'contractSha256':CONTRACT_SHA,'contractSourcePinsRechecked':len(bindings),'protectedFileCount':len(pins),'activeFocusSourceFileCount':len(focus['files']),'rootAuthorizationSha256':sha(AUTH.read_bytes()),'runtimeBehavior':'NOT_RUN','gitMutation':False}
    (OUT/'write-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))

main()

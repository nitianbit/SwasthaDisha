from pathlib import Path
import difflib
import hashlib
import json
import re
import shutil

ROOT = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
OUT = ROOT/'output/qa/customer-booking-write-owner/source'
AUTH = ROOT/'output/qa/customer-booking-write-owner/ROOT_AUTHORIZATION.json'
CONTROLLER = 'src1/modules/bookings/controller/index.ts'
CONTRACT = 'documentation/planning/implementation/CUSTOMER_BOOKING_WRITE_OWNER_CONTRACT_DRAFT.md'
BASELINE_SHA = 'bbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b'
CONTRACT_SHA = '723af082952ee39d39342080d2ba72205687f94244458a5e5dabf0d9c7ee8698'
ROOT_MESSAGE = "Authorize bounded customer write-owner implementation NOW. Two actual predecisions RootStandards+booking_read_specSpec recorded output/qa/customer-booking-write-owner/PREIMPLEMENTATION.json. Exactcontract723af082952ee39d39342080d2ba72205687f94244458a5e5dabf0d9c7ee8698, controllerbaselinebbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b. R3 snapshotdependencyresolved failedcaptureandallownedprocessescleaned; anyfutureClaude packetsbindfreshsource. Own only src1/modules/bookings/controller/index.ts plus output/qa/customer-booking-write-owner/source evidence + ROOT_AUTHORIZATION.json recordingthisactualmessage, no priorrecordoverwrites. Implement exactcontract: existingactorhelperrename, ONE sharedownerresolver getById/update/delete; distinctbyuserunchangedexcepthelpername; HR/read/service APIs and otherhandlerbytespreserved. Source/text-data verification scoped only (no applicationimports/TS/runtime); preserveall358sourcepins exceptthisfile, preserveearlierlab/sourceevidence. Meaningful negativelexicalcontrols only describelexicallimits; no artificialunitbehaviorclaim. Recordbefore/after/exactdiff/sourcefreeze and stop for actual2freshnonauthorreviews. NoGitmutations, no otherfiles. You are notalone; preserveotherworkers/originalsixstaged/archive. No finalmodule/race/policyacceptance."
sha = lambda data:hashlib.sha256(data).hexdigest()

def main():
    assert not OUT.exists() and not AUTH.exists(), 'No prior evidence/authorization record overwrite'
    original = (ROOT/CONTROLLER).read_bytes()
    assert sha(original) == BASELINE_SHA, 'Controller baseline drift'
    contract = (ROOT/CONTRACT).read_bytes()
    assert sha(contract) == CONTRACT_SHA, 'Contract drift'
    bindings = re.findall(r'\| `([^`]+)` \| `([0-9a-f]{64})` \|', contract.decode())
    assert len(bindings) == 17
    for name,digest in bindings:
        assert sha((ROOT/name).read_bytes()) == digest, 'Bound source drift: '+name
    approval = (ROOT/'output/qa/customer-booking-write-owner/PREIMPLEMENTATION.json').read_bytes()
    decisions = json.loads(approval)
    assert decisions['contractSha256'] == CONTRACT_SHA and decisions['controllerBaselineSha256'] == BASELINE_SHA
    assert {(d['agent'],d['role'],d['decision']) for d in decisions['reviewers']} == {
        ('/root/booking_read_spec','Spec','APPROVE_IMPLEMENTATION_ONLY'),
        ('/root','Standards','APPROVE_IMPLEMENTATION_ONLY'),
    }
    assert decisions['sourceCandidateAuthorized'] is False, 'Reconcile preimplementation record drift; do not overwrite it'
    parents = ('src1','test/foundation','output/qa/customer-booking-read','output/qa/lab-individual-association','output/qa/customer-api-docs')
    paths = [p for parent in parents for p in (ROOT/parent).rglob('*') if p.is_file()]
    paths += [ROOT/name for name in ('package.json','package-lock.json','tsconfig.json','server.js',CONTRACT,'documentation/planning/implementation/PHARMACY_PRESCRIPTION_CONSUMPTION_CONTRACT_DRAFT.md') if (ROOT/name).is_file()]
    assert all(not p.is_symlink() for p in paths)
    pins = {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in sorted(paths)}
    source_count = sum(name.startswith('src1/') for name in pins)
    assert source_count == 358, 'Unexpected app source inventory drift'
    before = original.decode()
    detail_old = """    const actor = this.requireBookingReadActor(req);
    const { id } = req.params;
    if (
      actor.userType === 'user' &&
      req.query.userId !== undefined &&
      req.query.userId !== actor._id
    ) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to bookings owned by another user is not permitted',
      });
    }

    await this.ensureHRCanAccessBooking(req, id);
    const userId = actor.userType === 'user'
      ? actor._id
      : req.query.userId as string | undefined;
"""
    detail_new = """    const userId = this.resolveBookingOwnerScope(req);
    const { id } = req.params;
    await this.ensureHRCanAccessBooking(req, id);
"""
    update_old = """  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const data: UpdateBookingRequest = req.body;
    const userId = req.query.userId as string | undefined;
"""
    update_new = """  update = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveBookingOwnerScope(req);
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const data: UpdateBookingRequest = req.body;
"""
    delete_old = """  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    this.ensureHRReadOnly(req);
    const { id } = req.params;
    const userId = req.query.userId as string | undefined;
"""
    delete_new = """  delete = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const userId = this.resolveBookingOwnerScope(req);
    this.ensureHRReadOnly(req);
    const { id } = req.params;
"""
    owner = """  private resolveBookingOwnerScope(req: AuthRequest): string | undefined {
    const actor = this.requireBookingActor(req);
    const userId = req.query.userId as string | undefined;
    if (actor.userType === 'user') {
      if (userId !== undefined && userId !== actor._id) {
        throw new AppError({
          status: 403,
          code: 'FORBIDDEN',
          message: 'Access to bookings owned by another user is not permitted',
        });
      }
      return actor._id;
    }

    return userId;
  }

"""
    candidate = before
    for old,new in ((detail_old,detail_new),(update_old,update_new),(delete_old,delete_new)):
        assert candidate.count(old) == 1, 'Exact baseline block not unique'
        candidate = candidate.replace(old,new,1)
    assert candidate.count('requireBookingReadActor') == 2, 'Only definition/by-user reference should remain before rename'
    candidate = candidate.replace('requireBookingReadActor','requireBookingActor')
    assert candidate.count('  private resolveHRBookingReadScope') == 1
    candidate = candidate.replace('  private resolveHRBookingReadScope',owner+'  private resolveHRBookingReadScope',1)
    OUT.mkdir()
    (OUT/'controller.before.ts.txt').write_bytes(original)
    (OUT/'controller.expected.ts.txt').write_text(candidate)
    (OUT/'preimplementation.snapshot.json').write_bytes(approval)
    (OUT/'protected-files.before.json').write_text(json.dumps(pins,indent=2)+'\n')
    shutil.copyfile('/private/tmp/customer-write-owner-source-check.py',OUT/'source-check.py')
    shutil.copyfile('/private/tmp/customer-write-owner-source-write.py',OUT/'source-write.py')
    authorization = {'schema':'SD-CUSTOMER-WRITE-OWNER-ROOT-AUTHORIZATION-1','recordedBy':'/root/customer_booking_writer','authorizingAgent':'/root','provenance':'ACTUAL_NATIVE_NEW_TASK_MESSAGE','actualMessage':ROOT_MESSAGE,'contractSha256':CONTRACT_SHA,'controllerBaselineSha256':BASELINE_SHA,'sourceCandidateAuthorized':True,'preimplementationRecordPreserved':True,'basis':'Two actual recorded implementation-only decisions plus the subsequent explicit Root message. The older sourceCandidateAuthorized:false snapshot remains unchanged.','runtimeAuthorized':False,'moduleAccepted':False,'raceOrPrivilegedFieldPolicyAccepted':False}
    AUTH.write_text(json.dumps(authorization,indent=2)+'\n')
    (ROOT/CONTROLLER).write_text(candidate)
    (OUT/'controller.after.ts.txt').write_bytes((ROOT/CONTROLLER).read_bytes())
    (OUT/'controller.diff').write_text(''.join(difflib.unified_diff(before.splitlines(keepends=True),candidate.splitlines(keepends=True),fromfile='a/'+CONTROLLER,tofile='b/'+CONTROLLER)))
    receipt = {'kind':'SOURCE_DATA_ONLY','baselineSha256':BASELINE_SHA,'candidateSha256':sha(candidate.encode()),'contractSha256':CONTRACT_SHA,'boundSourcePinsRechecked':len(bindings),'protectedFileCount':len(pins),'appSourcePins':source_count,'rootAuthorizationSha256':sha(AUTH.read_bytes()),'runtimeBehavior':'NOT_RUN','gitMutation':False}
    (OUT/'write-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))

main()

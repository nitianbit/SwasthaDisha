from pathlib import Path
import hashlib, json, difflib

ROOT = Path('/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab')
OUT = ROOT / 'output/qa/customer-booking-read/source'
CONTROLLER = 'src1/modules/bookings/controller/index.ts'
BASELINE = 'aec2b074981bfee5361b29b5f86ebed4e20c1837deadc75a9cc0766360be0f44'
CONTRACT = 'documentation/planning/implementation/CUSTOMER_BOOKING_READ_CONTRACT_DRAFT.md'
CONTRACT_SHA = '52a6f33e76db70a2a7ae8d29d2f45714107d750911fc2d4b2cdcef27840cdf4c'
sha = lambda data: hashlib.sha256(data).hexdigest()
def save_json(name, value):
    (OUT/name).write_text(json.dumps(value, indent=2) + '\n')

def main():
    assert not OUT.exists(), 'New source archive already exists; do not overwrite evidence'
    old = (ROOT/CONTROLLER).read_bytes()
    assert sha(old) == BASELINE, 'Controller baseline drift'
    assert sha((ROOT/CONTRACT).read_bytes()) == CONTRACT_SHA, 'Contract drift'
    approval = (ROOT/'output/qa/customer-booking-read/PREIMPLEMENTATION.json').read_bytes()
    decisions = json.loads(approval)
    assert decisions['contractSha256'] == CONTRACT_SHA
    assert {d['reviewer']: d['decision'] for d in decisions['decisions']} == {
        '/root/booking_read_spec': 'APPROVE_IMPLEMENTATION_ONLY',
        '/root/booking_read_standards': 'APPROVE_IMPLEMENTATION_ONLY',
    }, 'Preimplementation decisions not exact'
    assert decisions['rootAction'] == 'AUTHORIZE_EXACT_ONE_CONTROLLER_SOURCE_SLICE'
    assert decisions['runtimeApproved'] is False
    files = [p for parent in ('src1', 'test/foundation') for p in (ROOT/parent).rglob('*') if p.is_file()]
    files += [ROOT/name for name in ('package.json', 'package-lock.json', 'tsconfig.json', 'server.js') if (ROOT/name).is_file()]
    assert all(not p.is_symlink() for p in files), 'Unexpected symlink in pinned files'
    pins = {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in sorted(files)}
    OUT.mkdir()
    (OUT/'controller.before.ts.txt').write_bytes(old)
    (OUT/'preimplementation.snapshot.json').write_bytes(approval)
    save_json('protected-files.before.json', pins)
    helper = """  private requireBookingReadActor(req: AuthRequest) {
    const actor = req.user;
    if (
      !actor ||
      typeof actor._id !== 'string' ||
      actor._id.trim().length === 0 ||
      typeof actor.userType !== 'string' ||
      actor.userType.trim().length === 0
    ) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    return actor;
  }

"""
    old_detail = """  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const { id } = req.params;
    await this.ensureHRCanAccessBooking(req, id);
    const userId = req.query.userId as string | undefined;
    const result = await this.bookingService.getById(id, userId);
"""
    new_detail = """  getById = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const actor = this.requireBookingReadActor(req);
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
    const result = await this.bookingService.getById(id, userId);
"""
    old_list = """  getByUserId = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    const { userId } = req.params;
"""
    new_list = """  getByUserId = async (req: AuthRequest, res: Response, _next: NextFunction) => {
    const actor = this.requireBookingReadActor(req);
    const requestedUserId = req.query.userId;
    if (
      actor.userType === 'user' &&
      (req.params.userId !== actor._id ||
        (requestedUserId !== undefined &&
          (typeof requestedUserId !== 'string' ||
            requestedUserId.trim() !== actor._id)))
    ) {
      throw new AppError({
        status: 403,
        code: 'FORBIDDEN',
        message: 'Access to bookings owned by another user is not permitted',
      });
    }

    const requiredCorporateId = this.resolveHRBookingReadScope(req);
    const { userId } = req.params;
    const effectiveUserId = actor.userType === 'user' ? actor._id : userId;
"""
    text = old.decode()
    for part in (old_detail, old_list, '  private resolveHRBookingReadScope(', ': await this.bookingService.getByUserId(userId);'):
        assert text.count(part) == 1, 'Expected baseline fragment not unique'
    new = text.replace('  private resolveHRBookingReadScope(', helper + '  private resolveHRBookingReadScope(', 1)
    new = new.replace(old_detail, new_detail, 1).replace(old_list, new_list, 1)
    new = new.replace(': await this.bookingService.getByUserId(userId);', ': await this.bookingService.getByUserId(effectiveUserId);', 1)
    (OUT/'controller.expected.ts.txt').write_text(new)
    (ROOT/CONTROLLER).write_text(new)
    (OUT/'controller.after.ts.txt').write_bytes((ROOT/CONTROLLER).read_bytes())
    (OUT/'controller.diff').write_text(''.join(difflib.unified_diff(text.splitlines(keepends=True), new.splitlines(keepends=True), fromfile='a/'+CONTROLLER, tofile='b/'+CONTROLLER)))
    save_json('write-receipt.json', {'kind':'SOURCE_DATA_ONLY', 'baselineSha256':BASELINE, 'candidateSha256':sha(new.encode()), 'contractSha256':CONTRACT_SHA, 'protectedFileCount':len(pins), 'applicationExecution':'NOT_RUN', 'gitMutation':False})
    print(json.dumps({'written':CONTROLLER, 'candidateSha256':sha(new.encode()), 'archive':str(OUT), 'protectedFileCount':len(pins)}))

main()

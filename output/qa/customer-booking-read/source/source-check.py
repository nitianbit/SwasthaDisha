"""Source text/hash checks only. Does not parse, import or execute TypeScript."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
CONTROLLER = 'src1/modules/bookings/controller/index.ts'
CONTRACT = 'documentation/planning/implementation/CUSTOMER_BOOKING_READ_CONTRACT_DRAFT.md'
sha = lambda data: hashlib.sha256(data).hexdigest()

def block(text, start, end):
    if start not in text or end not in text:
        return ''
    return text.split(start, 1)[1].split(end, 1)[0]

def source_failures(text):
    helper = block(text, '  private requireBookingReadActor', '  private resolveHRBookingReadScope')
    detail = block(text, '  getById = async ', '  getPaymentDetails = async ')
    listing = block(text, '  getByUserId = async ', '  getUpcomingBookings = async ')
    errors = []
    def check(name, truth):
        if not truth:
            errors.append(name)
    check('ACTOR_HELPER_SYNCHRONOUS', helper.startswith('(req: AuthRequest) {') and 'await ' not in helper and 'try ' not in helper)
    check('ACTOR_REQUIRED_FIELDS', all(fragment in helper for fragment in (
        'const actor = req.user;', '!actor ||', "typeof actor._id !== 'string' ||", 'actor._id.trim().length === 0 ||',
        "typeof actor.userType !== 'string' ||", 'actor.userType.trim().length === 0', 'return actor;')))
    check('ACTOR_FIXED_401', all(fragment in helper for fragment in ('status: 401,', "code: 'UNAUTHORIZED',", "message: 'Authentication is required',")))
    for name, body, dispatch in (
        ('DETAIL', detail, 'await this.ensureHRCanAccessBooking(req, id);'),
        ('LIST', listing, 'const requiredCorporateId = this.resolveHRBookingReadScope(req);'),
    ):
        check(name + '_ACTOR_FIRST', body.startswith('(req: AuthRequest, res: Response, _next: NextFunction) => {\n    const actor = this.requireBookingReadActor(req);'))
        denial = "message: 'Access to bookings owned by another user is not permitted',"
        check(name + '_FIXED_403', 'status: 403,' in body and "code: 'FORBIDDEN'," in body and denial in body)
        check(name + '_DENIAL_BEFORE_DISPATCH', denial in body and dispatch in body and body.index(denial) < body.index(dispatch))
        check(name + '_SUCCESS_ENVELOPE', 'res.status(200).json({\n      success: true,\n      data: result,\n    });' in body)
    check('DETAIL_HINT_SCOPE', "actor.userType === 'user' &&\n      req.query.userId !== undefined &&\n      req.query.userId !== actor._id" in detail)
    check('DETAIL_SIGNED_OWNER', "const userId = actor.userType === 'user'\n      ? actor._id\n      : req.query.userId as string | undefined;" in detail)
    check('DETAIL_ONE_SCOPED_SERVICE_CALL', detail.count('this.bookingService.') == 1 and 'await this.bookingService.getById(id, userId);' in detail)
    check('LIST_PATH_SCOPE', "actor.userType === 'user' &&\n      (req.params.userId !== actor._id ||" in listing)
    check('LIST_QUERY_TYPE', "requestedUserId !== undefined &&\n          (typeof requestedUserId !== 'string' ||" in listing)
    check('LIST_QUERY_SCOPE', 'requestedUserId.trim() !== actor._id)))' in listing)
    check('LIST_SIGNED_OWNER', "const effectiveUserId = actor.userType === 'user' ? actor._id : userId;" in listing and 'await this.bookingService.getByUserId(effectiveUserId);' in listing)
    check('LIST_NONCUSTOMER_DISPATCH', "req.user?.userType === 'hr'\n        ? (\n            await this.bookingService.getAll({\n              userId,\n              corporateId: this.getHRCorporateId(req),\n            }, requiredCorporateId)\n          ).data" in listing)
    check('LIST_NO_ADDED_SERVICE_CALL', listing.count('this.bookingService.') == 2 and listing.count('this.bookingService.getByUserId(') == 1)
    check('HELPER_ONLY_TWO_READ_HANDLERS', text.count('this.requireBookingReadActor(req)') == 2)
    check('NO_NEW_FALLBACK_OR_CATCH', 'try ' not in detail + listing and 'catch ' not in detail + listing)
    return errors

def main():
    receipt_path = OUT / 'source-verification.json'
    assert not receipt_path.exists(), 'Never overwrite an existing verification receipt'
    receipt = {'kind': 'SOURCE_DATA_ONLY', 'argv': sys.argv, 'cwd': str(Path.cwd()), 'runtimeBehavior': 'NOT_RUN', 'checks': [], 'negativeControls': []}
    def require(name, truth):
        receipt['checks'].append({'name': name, 'sourceAssertion': 'ACCEPTED' if truth else 'REJECTED'})
        if not truth:
            receipt['firstFailure'] = name
            receipt['sourceVerdict'] = 'REJECTED'
            receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
            raise SystemExit('Source assertion rejected: ' + name)
    before = (OUT/'controller.before.ts.txt').read_text()
    candidate = (ROOT/CONTROLLER).read_text()
    after = (OUT/'controller.after.ts.txt').read_text()
    expected = (OUT/'controller.expected.ts.txt').read_text()
    require('BASELINE_PIN', sha(before.encode()) == 'aec2b074981bfee5361b29b5f86ebed4e20c1837deadc75a9cc0766360be0f44')
    require('CONTRACT_PIN', sha((ROOT/CONTRACT).read_bytes()) == '52a6f33e76db70a2a7ae8d29d2f45714107d750911fc2d4b2cdcef27840cdf4c')
    require('CANDIDATE_ARCHIVES_EXACT', candidate == after == expected)
    failures = source_failures(candidate)
    receipt['candidateSourceFailures'] = failures
    require('CANDIDATE_NAMED_SOURCE_ASSERTIONS', not failures)
    restored = candidate
    for start, end in (('  getById = async ', '  getPaymentDetails = async '), ('  getByUserId = async ', '  getUpcomingBookings = async ')):
        old_body = block(before, start, end)
        new_body = block(restored, start, end)
        restored = restored.replace(start + new_body + end, start + old_body + end, 1)
    helper = '  private requireBookingReadActor' + block(restored, '  private requireBookingReadActor', '  private resolveHRBookingReadScope')
    restored = restored.replace(helper, '', 1)
    require('ONLY_TWO_HANDLERS_AND_PRIVATE_HELPER_CHANGED', restored == before)
    pins = json.loads((OUT/'protected-files.before.json').read_text())
    current = {name: sha((ROOT/name).read_bytes()) if (ROOT/name).is_file() else 'MISSING' for name in pins}
    changed = [name for name in pins if pins[name] != current[name]]
    receipt['changedProtectedFiles'] = changed
    require('PROTECTED_FILES_ONLY_CONTROLLER_CHANGED', changed == [CONTROLLER])
    service = (ROOT/'src1/modules/bookings/services/index.ts').read_text()
    repository = (ROOT/'src1/modules/bookings/repository/index.ts').read_text()
    require('EXISTING_SERVICE_COMBINED_SCOPE_AND_404_TEXT', all(fragment in service for fragment in (
        'async getById(id: string, userId?: string)', 'const query: any = { _id: id };', 'query.userId = userId;',
        'await this.bookingRepository.findOne(query);', "code: 'BOOKING_NOT_FOUND',", "message: 'Booking not found',")))
    require('EXISTING_LIST_ORDER_TEXT', '{ userId },\n      { sort: { bookingDate: -1, createdAt: -1 } }' in repository)
    mutations = [
        ('baseline', before, 'ACTOR_REQUIRED_FIELDS'),
        ('missing_principal_field_check', candidate.replace("      typeof actor._id !== 'string' ||\n", '', 1), 'ACTOR_REQUIRED_FIELDS'),
        ('blank_role_check_removed', candidate.replace('      actor.userType.trim().length === 0', '      false', 1), 'ACTOR_REQUIRED_FIELDS'),
        ('detail_actor_guard_removed', candidate.replace('    const actor = this.requireBookingReadActor(req);\n', '', 1), 'DETAIL_ACTOR_FIRST'),
        ('detail_foreign_hint_admitted', candidate.replace('      req.query.userId !== actor._id', '      false', 1), 'DETAIL_HINT_SCOPE'),
        ('detail_query_owner_forwarded', candidate.replace('      ? actor._id\n      : req.query.userId', '      ? req.query.userId\n      : req.query.userId', 1), 'DETAIL_SIGNED_OWNER'),
        ('detail_unscoped_read', candidate.replace('this.bookingService.getById(id, userId);', 'this.bookingService.getById(id);', 1), 'DETAIL_ONE_SCOPED_SERVICE_CALL'),
        ('detail_unscoped_fallback', candidate.replace('const result = await this.bookingService.getById(id, userId);', 'const result = await this.bookingService.getById(id, userId) || await this.bookingService.getById(id);', 1), 'DETAIL_ONE_SCOPED_SERVICE_CALL'),
        ('list_foreign_path_admitted', candidate.replace('req.params.userId !== actor._id ||', 'false ||', 1), 'LIST_PATH_SCOPE'),
        ('list_query_type_check_removed', candidate.replace("typeof requestedUserId !== 'string' ||", 'false ||', 1), 'LIST_QUERY_TYPE'),
        ('list_query_owner_check_removed', candidate.replace('requestedUserId.trim() !== actor._id)))', 'false)))', 1), 'LIST_QUERY_SCOPE'),
        ('list_path_forwarded', candidate.replace('this.bookingService.getByUserId(effectiveUserId);', 'this.bookingService.getByUserId(userId);', 1), 'LIST_SIGNED_OWNER'),
    ]
    for name, variant, intended in mutations:
        rejected_by = source_failures(variant)
        receipt['negativeControls'].append({'name': name, 'intended': intended, 'rejectedByNamedSourceAssertions': rejected_by, 'variantSha256': sha(variant.encode()), 'scope': 'in-memory TypeScript text only'})
        require('NEGATIVE_CONTROL_' + name, variant != candidate and intended in rejected_by)
    (OUT/'protected-files.after.json').write_text(json.dumps(current, indent=2) + '\n')
    receipt.update({'sourceVerdict': 'ACCEPTED', 'candidateSha256': sha(candidate.encode()), 'baselineSha256': sha(before.encode()), 'protectedFileCount': len(pins), 'negativeControlCount': len(mutations), 'scriptSha256': sha(Path(__file__).read_bytes()), 'gitMutation': False, 'limitations': ['Lexical assertions and byte comparisons only; no TypeScript parser/compiler or application execution.', 'Negative controls modify source text in memory; no behavior, counters, JWT, Joi, router, service, repository or database result is proven.', 'Focused runtime behavior needs separate complete C3 admission; the owner deferred the final cross-module integration campaign.']})
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'sourceVerdict': receipt['sourceVerdict'], 'candidateSha256': receipt['candidateSha256'], 'protectedFileCount': len(pins), 'negativeControlCount': len(mutations), 'runtimeBehavior': 'NOT_RUN'}))

if __name__ == '__main__':
    main()

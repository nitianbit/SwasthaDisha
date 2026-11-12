"""Lexical source assertions and byte hashes only; no TypeScript execution."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
CONTROLLER = 'src1/modules/bookings/controller/index.ts'
BASELINE_SHA = 'bbe2d226d0192b91389675dd5e66f2b385dc157bba0010715bbe4b29b0e2848b'
sha = lambda data: hashlib.sha256(data).hexdigest()

def segment(text, start, end):
    if start not in text or end not in text:
        return ''
    return text.split(start,1)[1].split(end,1)[0]

def handler(text, name, following):
    return segment(text, '  '+name+' = async ', '  '+following+' = async ')

def failures(text, baseline):
    results = []
    def require(name, truth):
        if not truth:
            results.append(name)
    actor = segment(text, '  private requireBookingActor', '  private resolveBookingOwnerScope')
    owner = segment(text, '  private resolveBookingOwnerScope', '  private resolveHRBookingReadScope')
    require('ACTOR_REQUIRED_FIELDS', all(s in actor for s in (
        'const actor = req.user;', '!actor ||', "typeof actor._id !== 'string' ||", 'actor._id.trim().length === 0 ||',
        "typeof actor.userType !== 'string' ||", 'actor.userType.trim().length === 0', 'return actor;')))
    require('ACTOR_FIXED_401', all(s in actor for s in ('status: 401,', "code: 'UNAUTHORIZED',", "message: 'Authentication is required',")))
    require('ACTOR_SYNC', actor.startswith('(req: AuthRequest) {') and 'await ' not in actor and 'try ' not in actor)
    require('OWNER_RESOLVER_PRESENT', owner.startswith('(req: AuthRequest): string | undefined {'))
    require('OWNER_ACTOR_FIRST', owner.startswith('(req: AuthRequest): string | undefined {\n    const actor = this.requireBookingActor(req);'))
    require('OWNER_QUERY_SOURCE', 'const userId = req.query.userId as string | undefined;' in owner)
    require('OWNER_STRICT_FOREIGN_HINT', "if (actor.userType === 'user') {\n      if (userId !== undefined && userId !== actor._id) {" in owner)
    require('OWNER_FIXED_403', all(s in owner for s in ('status: 403,', "code: 'FORBIDDEN',", "message: 'Access to bookings owned by another user is not permitted',")))
    require('OWNER_SIGNED_OWNER', '      return actor._id;\n    }' in owner)
    require('OWNER_NONCUSTOMER_FORWARD', '    }\n\n    return userId;\n  }\n\n' in owner)
    require('OWNER_SYNC_NO_DISPATCH', 'await ' not in owner and 'this.bookingService.' not in owner and 'try ' not in owner)
    for name, following, dispatch, call in (
        ('getById','getPaymentDetails','await this.ensureHRCanAccessBooking(req, id);','const result = await this.bookingService.getById(id, userId);'),
        ('update','delete','this.ensureHRReadOnly(req);','const result = await this.bookingService.update(id, data, userId);'),
        ('delete','getByUserId','this.ensureHRReadOnly(req);','await this.bookingService.delete(id, userId);'),
    ):
        body = handler(text,name,following)
        require(name+':OWNER_FIRST', body.startswith('(req: AuthRequest, res: Response, _next: NextFunction) => {\n    const userId = this.resolveBookingOwnerScope(req);'))
        require(name+':HR_BEFORE_SERVICE', dispatch in body and call in body and body.index(dispatch) < body.index(call))
        require(name+':ONE_SCOPED_SERVICE_CALL', body.count('this.bookingService.') == 1 and call in body)
        require(name+':NO_QUERY_OVERRIDE', 'req.query.userId' not in body)
    byuser = handler(text,'getByUserId','getUpcomingBookings')
    oldbyuser = handler(baseline,'getByUserId','getUpcomingBookings')
    require('BYUSER_ONLY_ACTOR_NAME_CHANGED', byuser == oldbyuser.replace('requireBookingReadActor','requireBookingActor'))
    require('HELPER_CALL_SCOPE', text.count('this.resolveBookingOwnerScope(req)') == 3 and text.count('this.requireBookingActor(req)') == 2 and 'requireBookingReadActor' not in text)
    return results

def main():
    receipt = OUT/'source-verification.json'
    assert not receipt.exists(), 'Never overwrite source check evidence'
    report = {'kind':'SOURCE_DATA_ONLY', 'argv':sys.argv, 'cwd':str(Path.cwd()), 'checks':[], 'negativeControls':[], 'runtimeBehavior':'NOT_RUN'}
    def require(name, truth):
        report['checks'].append({'name':name,'sourceAssertion':'ACCEPTED' if truth else 'REJECTED'})
        if not truth:
            report.update({'sourceVerdict':'REJECTED','firstFailure':name})
            receipt.write_text(json.dumps(report,indent=2)+'\n')
            raise SystemExit('Source assertion rejected: '+name)
    baseline = (OUT/'controller.before.ts.txt').read_text()
    candidate = (ROOT/CONTROLLER).read_text()
    require('BASELINE_PIN',sha(baseline.encode()) == BASELINE_SHA)
    require('AFTER_EXPECTED_ARCHIVES_EXACT', candidate == (OUT/'controller.after.ts.txt').read_text() == (OUT/'controller.expected.ts.txt').read_text())
    report['candidateSourceFailures'] = failures(candidate,baseline)
    require('NAMED_CANDIDATE_SOURCE_ASSERTIONS', not report['candidateSourceFailures'])
    restored = candidate
    owner = '  private resolveBookingOwnerScope' + segment(restored,'  private resolveBookingOwnerScope','  private resolveHRBookingReadScope')
    restored = restored.replace(owner,'',1).replace('requireBookingActor','requireBookingReadActor')
    for name,following in (('getById','getPaymentDetails'),('update','delete'),('delete','getByUserId')):
        start,end = '  '+name+' = async ','  '+following+' = async '
        new,old = handler(restored,name,following),handler(baseline,name,following)
        restored = restored.replace(start+new+end,start+old+end,1)
    require('ONLY_REVIEWED_HELPER_AND_HANDLERS_CHANGED', restored == baseline)
    pins = json.loads((OUT/'protected-files.before.json').read_text())
    current = {name:sha((ROOT/name).read_bytes()) if (ROOT/name).is_file() else 'MISSING' for name in pins}
    changed = [name for name in pins if current[name] != pins[name]]
    report['changedProtectedFiles'] = changed
    require('ONLY_CONTROLLER_CHANGED_IN_PROTECTED_FILES',changed == [CONTROLLER])
    variants = [('baseline',baseline,'OWNER_RESOLVER_PRESENT')]
    common = (
        ('missing_actor_check_removed', '!actor ||','false ||','ACTOR_REQUIRED_FIELDS'),
        ('blank_actor_id_allowed','actor._id.trim().length === 0 ||','false ||','ACTOR_REQUIRED_FIELDS'),
        ('foreign_hint_allowed','userId !== undefined && userId !== actor._id','false','OWNER_STRICT_FOREIGN_HINT'),
        ('query_owner_forwarded','      return actor._id;','      return userId;','OWNER_SIGNED_OWNER'),
        ('noncustomer_restricted','    return userId;\n  }\n\n  private resolveHRBookingReadScope','    return actor._id;\n  }\n\n  private resolveHRBookingReadScope','OWNER_NONCUSTOMER_FORWARD'),
        ('async_owner_resolver','private resolveBookingOwnerScope','private async resolveBookingOwnerScope','OWNER_RESOLVER_PRESENT'),
        ('wrong_foreign_error','status: 403,','status: 401,','OWNER_FIXED_403'),
    )
    for name,old,new,intended in common:
        variants.append((name,candidate.replace(old,new,1),intended))
    for name,following,hr,call in (
        ('getById','getPaymentDetails','await this.ensureHRCanAccessBooking(req, id);','const result = await this.bookingService.getById(id, userId);'),
        ('update','delete','this.ensureHRReadOnly(req);','const result = await this.bookingService.update(id, data, userId);'),
        ('delete','getByUserId','this.ensureHRReadOnly(req);','await this.bookingService.delete(id, userId);'),
    ):
        body = handler(candidate,name,following)
        first = '    const userId = this.resolveBookingOwnerScope(req);\n'
        altered = body.replace(first,'',1).replace('    '+hr,'    '+hr+'\n'+first.rstrip(),1)
        variants.append((name+':late_guard',candidate.replace(body,altered,1),name+':OWNER_FIRST'))
        altered = body.replace(first,'    const userId = req.query.userId as string | undefined;\n',1)
        variants.append((name+':query_override',candidate.replace(body,altered,1),name+':NO_QUERY_OVERRIDE'))
        altered = body.replace(hr,'',1)
        variants.append((name+':hr_guard_removed',candidate.replace(body,altered,1),name+':HR_BEFORE_SERVICE'))
        altered = body.replace(call,call+'\n    await this.bookingService.getById(id);',1)
        variants.append((name+':unscoped_extra_read',candidate.replace(body,altered,1),name+':ONE_SCOPED_SERVICE_CALL'))
    listing = handler(candidate,'getByUserId','getUpcomingBookings')
    weakened = listing.replace('req.params.userId !== actor._id ||','false ||',1)
    variants.append(('byuser_path_weakened',candidate.replace(listing,weakened,1),'BYUSER_ONLY_ACTOR_NAME_CHANGED'))
    for name,variant,intended in variants:
        rejected = failures(variant,baseline)
        report['negativeControls'].append({'name':name,'intended':intended,'rejectedByNamedSourceAssertions':rejected,'variantSha256':sha(variant.encode()),'scope':'in-memory TypeScript text only'})
        require('NEGATIVE_CONTROL_'+name,variant != candidate and intended in rejected)
        require('RESTORED_SOURCE_CONTROL_'+name,not failures(candidate,baseline))
    (OUT/'protected-files.after.json').write_text(json.dumps(current,indent=2)+'\n')
    report.update({'sourceVerdict':'ACCEPTED','baselineSha256':sha(baseline.encode()),'candidateSha256':sha(candidate.encode()),'protectedFileCount':len(pins),'negativeControlCount':len(variants),'restoredSourceControlCount':len(variants),'scriptSha256':sha(Path(__file__).read_bytes()),'gitMutation':False,'limitations':['Lexical text assertions and exact byte comparisons only; no TypeScript parser/compiler or application behavior tested.','Negative and restored controls operate on text in memory, not executed handlers, services, Joi or database predicates.','Focused execution remains NOT_RUN pending complete C3; final cross-module integration is DEFERRED_BY_OWNER.','Ownerless final mutation races, own privileged fields and deletion/refund/provider policies remain P0 and are not approved by this owner-prefetch slice.']})
    receipt.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ('sourceVerdict','candidateSha256','protectedFileCount','negativeControlCount','restoredSourceControlCount','runtimeBehavior')}))

if __name__ == '__main__':
    main()

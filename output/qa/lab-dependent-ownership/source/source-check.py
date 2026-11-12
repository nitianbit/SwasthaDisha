"""Lexical TypeScript-as-data checks only; no parser/compiler/application execution."""
from pathlib import Path
import hashlib,json,sys
ROOT=Path(__file__).resolve().parents[4]
OUT=Path(__file__).resolve().parent
TARGET='src1/modules/externalBookings/controller/index.ts'
sha=lambda data:hashlib.sha256(data).hexdigest()

def between(text,start,end):
    return text.split(start,1)[1].split(end,1)[0] if start in text and end in text else ''

def body(text,name,nextname):
    return between(text,'  '+name+' = async (','  '+nextname+' = async (')

def failures(text):
    helper=between(text,'  private async assertCustomerDependentOwner','  private resolveIntegration')
    result=[]
    def need(name,truth):
        if not truth: result.append(name)
    need('DEPENDENT_SERVICE_CONSTRUCTION', all(s in text for s in ("import { DependentService } from '@/modules/dependents/services';",'  private dependentService: DependentService;','    this.dependentService = Container.get(DependentService);')))
    need('GUARD_PRESENT',helper.startswith('(req: AuthRequest): Promise<void> {'))
    need('EXACT_USER_ONLY',"const actor = req.user;\n    if (actor?.userType !== 'user') {\n      return;\n    }" in helper)
    need('SIGNED_OWNER_REQUIRED',"typeof actor._id !== 'string' || actor._id.trim().length === 0" in helper)
    need('FIXED_ACTOR_401',all(s in helper for s in ('status: 401,',"code: 'UNAUTHORIZED',","message: 'Authentication is required',")))
    need('OMITTED_DEPENDENT_NO_LOOKUP','const dependentId = req.body.dependentId;\n    if (dependentId === undefined) {\n      return;\n    }' in helper)
    need('DEPENDENT_LOCAL_SHAPE',"typeof dependentId !== 'string' ||\n      !/^[0-9a-fA-F]{24}$/.test(dependentId)" in helper)
    need('FIXED_DEPENDENT_404',all(s in helper for s in ('status: 404,',"code: 'DEPENDENT_NOT_FOUND',","message: 'Dependent not found',")))
    need('ONE_AWAITED_SIGNED_LOOKUP',helper.count('this.dependentService.')==1 and 'await this.dependentService.getById(dependentId, actor._id);' in helper)
    need('NO_FALLBACK_OR_NEW_POLICY',all(s not in helper for s in ('catch','try ','isActive','req.body.userId','req.query','patientName','this.externalBookingService.')))
    needed=('status: 401,','const dependentId = req.body.dependentId;','status: 404,','await this.dependentService.getById(')
    need('GUARD_ORDER',all(s in helper for s in needed) and [helper.index(s) for s in needed]==sorted(helper.index(s) for s in needed))
    for name,nextname in (('createBooking','createDiagnosticsBooking'),('createDiagnosticsBooking','retryConsultationPayment')):
        current=body(text,name,nextname)
        need(name+':FIRST_AWAIT',current.startswith("\n    req: AuthRequest,\n    res: Response,\n    _next: NextFunction\n  ) => {\n    await this.assertCustomerDependentOwner(req);\n"))
    need('GUARD_ONLY_TWO_CREATE_CALLERS',text.count('this.assertCustomerDependentOwner(req)')==2)
    return result

def main():
    receipt=OUT/'source-verification.json'
    assert not receipt.exists(),'Do not overwrite verification evidence'
    report={'kind':'SOURCE_DATA_ONLY','argv':sys.argv,'cwd':str(Path.cwd()),'checks':[],'negativeControls':[],'runtimeBehavior':'NOT_RUN'}
    def need(name,truth):
        report['checks'].append({'name':name,'sourceAssertion':'ACCEPTED' if truth else 'REJECTED'})
        if not truth:
            report.update({'sourceVerdict':'REJECTED','firstFailure':name})
            receipt.write_text(json.dumps(report,indent=2)+'\n')
            raise SystemExit('Source assertion rejected: '+name)
    old=(OUT/'controller.before.ts.txt').read_text()
    candidate=(ROOT/TARGET).read_text()
    need('BASELINE_PIN',sha(old.encode())=='b036cc91db6abf4cecfc2963fa02ab04b12bd8c8048c7c979468080a778942ce')
    need('EXACT_CANDIDATE_ARCHIVES',candidate==(OUT/'controller.expected.ts.txt').read_text()==(OUT/'controller.after.ts.txt').read_text())
    report['candidateSourceFailures']=failures(candidate)
    need('CANDIDATE_NAMED_LEXICAL_ASSERTIONS',not report['candidateSourceFailures'])
    helper='  private async assertCustomerDependentOwner'+between(candidate,'  private async assertCustomerDependentOwner','  private resolveIntegration')
    restored=candidate.replace(helper,'',1)
    for added in ("import { DependentService } from '@/modules/dependents/services';\n","import { AppError } from '@/modules/common/types';\n",'  private dependentService: DependentService;\n','    this.dependentService = Container.get(DependentService);\n'):
        restored=restored.replace(added,'',1)
    restored=restored.replace('    await this.assertCustomerDependentOwner(req);\n','')
    need('ONLY_IMPORT_FIELD_CONSTRUCTOR_GUARD_AND_TWO_AWAITS_CHANGED',restored==old)
    pins=json.loads((OUT/'protected-files.before.json').read_text())
    after={name:sha((ROOT/name).read_bytes()) if (ROOT/name).is_file() else 'MISSING' for name in pins}
    changed=[name for name in pins if after[name]!=pins[name]]
    report['changedProtectedFiles']=changed
    need('ONLY_ISOLATED_CONTROLLER_CHANGED',changed==[TARGET])
    focus=json.loads((OUT/'focus-source.before.json').read_text())
    focusroot=Path(focus['root'])
    focusafter={name:sha((focusroot/name).read_bytes()) if (focusroot/name).is_file() else 'MISSING' for name in focus['files']}
    need('ACTIVE_FOCUS_SOURCE_UNCHANGED',focusafter==focus['files'])
    variants=[('baseline',old,'GUARD_PRESENT')]
    changes=(
        ('role_scope_expanded',"actor?.userType !== 'user'","false",'EXACT_USER_ONLY'),
        ('blank_owner_allowed','actor._id.trim().length === 0','false','SIGNED_OWNER_REQUIRED'),
        ('omitted_id_falls_through','if (dependentId === undefined)','if (false)','OMITTED_DEPENDENT_NO_LOOKUP'),
        ('malformed_id_not_checked','!/^[0-9a-fA-F]{24}$/.test(dependentId)','false','DEPENDENT_LOCAL_SHAPE'),
        ('lookup_owner_from_body','getById(dependentId, actor._id);','getById(dependentId, req.body.userId);','ONE_AWAITED_SIGNED_LOOKUP'),
        ('lookup_unscoped','getById(dependentId, actor._id);','getById(dependentId);','ONE_AWAITED_SIGNED_LOOKUP'),
        ('lookup_unawaited','await this.dependentService.getById','this.dependentService.getById','ONE_AWAITED_SIGNED_LOOKUP'),
        ('lookup_failure_swallowed','getById(dependentId, actor._id);','getById(dependentId, actor._id).catch(() => undefined);','NO_FALLBACK_OR_NEW_POLICY'),
    )
    for name,before,aftertext,intended in changes:
        variants.append((name,candidate.replace(before,aftertext,1),intended))
    for name,nextname in (('createBooking','createDiagnosticsBooking'),('createDiagnosticsBooking','retryConsultationPayment')):
        original=body(candidate,name,nextname)
        call='    await this.assertCustomerDependentOwner(req);\n'
        for label,altered in (
            ('guard_removed',original.replace(call,'',1)),
            ('guard_unawaited',original.replace(call,'    this.assertCustomerDependentOwner(req);\n',1)),
            ('guard_after_account_read',original.replace(call,'',1).replace('      : null;\n','      : null;\n'+call,1)),
        ):
            variants.append((name+':'+label,candidate.replace(original,altered,1),name+':FIRST_AWAIT'))
    for name,variant,intended in variants:
        rejected=failures(variant)
        report['negativeControls'].append({'name':name,'intended':intended,'rejectedByNamedSourceAssertions':rejected,'variantSha256':sha(variant.encode()),'scope':'in-memory source text only'})
        need('NEGATIVE_CONTROL_'+name,variant!=candidate and intended in rejected)
        need('RESTORED_SOURCE_CONTROL_'+name,not failures(candidate))
    (OUT/'protected-files.after.json').write_text(json.dumps(after,indent=2)+'\n')
    (OUT/'focus-source.after.json').write_text(json.dumps({'root':str(focusroot),'files':focusafter},indent=2)+'\n')
    report.update({'sourceVerdict':'ACCEPTED','candidateSha256':sha(candidate.encode()),'protectedFileCount':len(pins),'activeFocusSourceFileCount':len(focusafter),'negativeControlCount':len(variants),'restoredSourceControlCount':len(variants),'scriptSha256':sha(Path(__file__).read_bytes()),'gitMutation':False,'limitations':['Lexical assertions and byte comparisons only; no TypeScript/parser/compiler/application execution.','Negative/restored controls manipulate text; they do not prove runtime Joi/HTTP/query/effect behavior.','Expanded constructor closure and focused actual behavior require separate complete C3 admission.','No consent/guardian/activity/demographic/TOCTOU or module acceptance; final integration DEFERRED_BY_OWNER.']})
    receipt.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ('sourceVerdict','candidateSha256','protectedFileCount','activeFocusSourceFileCount','negativeControlCount','restoredSourceControlCount','runtimeBehavior')}))

if __name__=='__main__': main()

"""Read TypeScript as text only; no parser, compiler or application execution."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = Path(__file__).resolve().parent
CONTROLLER = 'src1/modules/externalBookings/controller/index.ts'
OLD = ': req.user?.corporateId || (req.body.corporateId as string | undefined),'
NEW = ': req.user?.corporateId,'
ASSOCIATION = """      corporateId:
        req.user?.userType === 'admin'
          ? (req.body.corporateId as string | undefined)
          : req.user?.corporateId,
"""
OWNER = """    const userId = req.user
      ? req.user.userType === 'admin'
        ? ((req.body.userId as string | undefined) || req.user._id)
        : req.user._id
      : ((req.body.userId as string | undefined) || 'test-user');"""
sha = lambda data: hashlib.sha256(data).hexdigest()

def handlers(text):
    return {name: text.split('  ' + name + ' = async (', 1)[1].split('  ' + following + ' = async (', 1)[0]
            for name, following in (('createBooking', 'createDiagnosticsBooking'), ('createDiagnosticsBooking', 'retryConsultationPayment'))}

def failures(text):
    result = []
    for name, body in handlers(text).items():
        def require(label, truth):
            if not truth:
                result.append(name + ':' + label)
        data = body.split('    const data: ', 1)[1].split('    };', 1)[0]
        require('NO_BODY_ASSOCIATION_FALLBACK', OLD not in body and NEW in body)
        require('ADMIN_BODY_ASSOCIATION_RETAINED', "req.user?.userType === 'admin'\n          ? (req.body.corporateId as string | undefined)" in data)
        require('TRUSTED_ACTOR_ASSOCIATION_RETAINED', '\n          ' + NEW in data)
        require('EXPLICIT_ASSOCIATION_AFTER_SPREAD', '...req.body,' in data and ASSOCIATION in data and data.index('...req.body,') < data.index(ASSOCIATION))
        require('SIGNED_OWNER_RESOLVER_RETAINED', OWNER in body)
        require('EXPLICIT_OWNER_AFTER_SPREAD', '...req.body,' in data and '\n      userId,\n' in data and data.index('...req.body,') < data.index('\n      userId,\n'))
    return result

def main():
    report_path = OUT/'source-verification.json'
    assert not report_path.exists(), 'Never overwrite source evidence'
    report = {'kind':'SOURCE_DATA_ONLY', 'argv':sys.argv, 'cwd':str(Path.cwd()), 'checks':[], 'negativeControls':[], 'runtimeBehavior':'NOT_RUN'}
    def require(label, truth):
        report['checks'].append({'name':label, 'sourceAssertion':'ACCEPTED' if truth else 'REJECTED'})
        if not truth:
            report.update({'sourceVerdict':'REJECTED', 'firstFailure':label})
            report_path.write_text(json.dumps(report, indent=2)+'\n')
            raise SystemExit('Source assertion rejected: '+label)
    before = (OUT/'controller.before.ts.txt').read_text()
    candidate = (ROOT/CONTROLLER).read_text()
    require('EXACT_BASELINE_SHA', sha(before.encode()) == '67ebcef4ec0b7f21c9bf2c9c274a6d6066499ef34f0637fa3fa0ee36fde2acd3')
    require('EXACT_TWO_FALLBACK_REMOVALS', before.count(OLD) == 2 and candidate == before.replace(OLD, NEW))
    require('AFTER_ARCHIVE_EXACT', candidate == (OUT/'controller.after.ts.txt').read_text())
    report['candidateSourceFailures'] = failures(candidate)
    require('CANDIDATE_NAMED_SOURCE_ASSERTIONS', not report['candidateSourceFailures'])
    pins = json.loads((OUT/'protected-files.before.json').read_text())
    after = {name:sha((ROOT/name).read_bytes()) if (ROOT/name).is_file() else 'MISSING' for name in pins}
    changed = [name for name in pins if pins[name] != after[name]]
    report['changedProtectedFiles'] = changed
    require('ONLY_OWNED_CONTROLLER_CHANGED_IN_PINNED_FILES', changed == [CONTROLLER])
    variants = [('baseline', before, 'createBooking:NO_BODY_ASSOCIATION_FALLBACK')]
    bodies = handlers(candidate)
    for name, body in bodies.items():
        changes = (
            ('restored_fallback', body.replace(NEW, OLD, 1), 'NO_BODY_ASSOCIATION_FALLBACK'),
            ('association_before_spread', body.replace(ASSOCIATION, '', 1).replace('      ...req.body,\n', ASSOCIATION + '      ...req.body,\n', 1), 'EXPLICIT_ASSOCIATION_AFTER_SPREAD'),
            ('foreign_body_owner', body.replace('        : req.user._id\n', '        : req.body.userId\n', 1), 'SIGNED_OWNER_RESOLVER_RETAINED'),
            ('admin_body_association_lost', body.replace('? (req.body.corporateId as string | undefined)', '? req.user?.corporateId', 1), 'ADMIN_BODY_ASSOCIATION_RETAINED'),
            ('trusted_actor_association_lost', body.replace(NEW, ': undefined,', 1), 'TRUSTED_ACTOR_ASSOCIATION_RETAINED'),
            ('owner_before_spread', body.replace('\n      userId,\n', '\n', 1).replace('      ...req.body,\n', '      userId,\n      ...req.body,\n', 1), 'EXPLICIT_OWNER_AFTER_SPREAD'),
        )
        for label, variant_body, expected in changes:
            variants.append((name + ':' + label, candidate.replace(body, variant_body, 1), name + ':' + expected))
    for label, variant, intended in variants:
        rejected = failures(variant)
        report['negativeControls'].append({'name':label, 'intended':intended, 'rejectedByNamedSourceAssertions':rejected, 'variantSha256':sha(variant.encode()), 'scope':'in-memory source text only'})
        require('NEGATIVE_CONTROL_'+label, variant != candidate and intended in rejected)
        require('RESTORED_SOURCE_CONTROL_'+label, not failures(candidate))
    (OUT/'protected-files.after.json').write_text(json.dumps(after, indent=2)+'\n')
    report.update({'sourceVerdict':'ACCEPTED', 'candidateSha256':sha(candidate.encode()), 'baselineSha256':sha(before.encode()), 'protectedFileCount':len(pins), 'negativeControlCount':len(variants), 'restoredSourceControlCount':len(variants), 'scriptSha256':sha(Path(__file__).read_bytes()), 'gitMutation':False, 'limitations':['Lexical source assertions and hashes only; no TypeScript/parser/compiler/application execution.', 'Restored controls recheck original candidate text only; no executed positive behavior is established.', 'Auth/Joi/DTO/persistence/coupon/payment/provider behavior remains NOT_RUN pending complete C3 admission.', 'Existing save/pricing/conditional slot-freeze before coupon denial is preserved; no zero-effects or rollback claim.', 'Final cross-module integration campaign remains DEFERRED_BY_OWNER.']})
    report_path.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ('sourceVerdict','candidateSha256','protectedFileCount','negativeControlCount','restoredSourceControlCount','runtimeBehavior')}))

if __name__ == '__main__':
    main()

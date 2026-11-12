"""Source text/hash checks only; no TypeScript or application execution."""
from pathlib import Path
import hashlib,json,sys
ROOT=Path(__file__).resolve().parents[4]
OUT=Path(__file__).resolve().parent
TARGET='src1/modules/pharmacyOrders/services/index.ts'
LIST="""const PRESCRIPTION_GATED_STATUSES: OrderStatus[] = [
  'packed',
  'ready_for_pickup',
  'out_for_delivery',
  'completed',
];
"""
BOOLEAN='    const requiresPrescriptionCheck = PRESCRIPTION_GATED_STATUSES.includes(payload.status);\n'
GUARD="""    if (
      requiresPrescriptionCheck &&
      order.prescriptionStatus !== 'approved' &&
      order.prescriptionStatus !== 'not_required'
    ) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PRESCRIPTION_APPROVAL_REQUIRED',
        message: 'Prescription approval is required before the order can be completed',
      });
    }
"""
sha=lambda data:hashlib.sha256(data).hexdigest()

def section(text):
    return text.split('  async updateStatus(',1)[1].split('  async markPaid(',1)[0]

def failures(text):
    part=section(text)
    result=[]
    def need(name,truth):
        if not truth: result.append(name)
    need('ONE_EXACT_PRIVATE_TARGET_LIST',text.count(LIST)==1 and text.count('const PRESCRIPTION_GATED_STATUSES')==1 and 'export const PRESCRIPTION_GATED_STATUSES' not in text)
    need('ONE_TARGET_DERIVATION',text.count(BOOLEAN)==1 and text.count('PRESCRIPTION_GATED_STATUSES')==2 and text.count('requiresPrescriptionCheck')==3)
    need('SHARED_GUARD',"if (\n      requiresPrescriptionCheck &&\n      order.prescriptionStatus" in part)
    need('CLOSED_RX_ALLOWLIST',"order.prescriptionStatus !== 'approved' &&\n      order.prescriptionStatus !== 'not_required'\n" in part)
    need('SHARED_CAS',"...(requiresPrescriptionCheck\n            ? { prescriptionStatus: order.prescriptionStatus }\n            : {})," in part)
    need('EXACT_OBSERVED_CAS',"? { prescriptionStatus: order.prescriptionStatus }\n" in part and "prescriptionStatus: { $in:" not in part)
    need('UNCHANGED_ERROR_API',GUARD in part)
    payment='Payment must be completed before the order can be completed'
    order=(payment,BOOLEAN.strip(),"code: 'ORDER_PRESCRIPTION_APPROVAL_REQUIRED'",'const inventoryItems =','const updated = await this.runOrderInventoryTransaction')
    need('PAYMENT_BEFORE_RX_BEFORE_EFFECTS',all(s in part for s in order) and [part.index(s) for s in order]==sorted(part.index(s) for s in order))
    need('SESSION_OPTION','{ new: true, session }\n      );' in part)
    need('COMPLETION_ONLY_CONSUMPTION',"if (payload.status === 'completed') {\n        await this.consumeOrderInventory(pharmacyId, order.items, session);" in part)
    steps=('const nextOrder = await this.orderRepo.update(',"if (!nextOrder) {",'if (shouldReturnInventory && inventoryItems.length)','await this.consumeOrderInventory(')
    need('CAS_AND_NO_MATCH_BEFORE_INVENTORY',all(s in part for s in steps) and [part.index(s) for s in steps]==sorted(part.index(s) for s in steps))
    return result

def main():
    receipt=OUT/'source-verification.json'
    assert not receipt.exists(),'Never overwrite source evidence'
    report={'kind':'SOURCE_DATA_ONLY','argv':sys.argv,'cwd':str(Path.cwd()),'checks':[],'negativeControls':[],'runtimeBehavior':'NOT_RUN','F1':'HIGH_OPEN'}
    def need(name,truth):
        report['checks'].append({'name':name,'sourceAssertion':'ACCEPTED' if truth else 'REJECTED'})
        if not truth:
            report.update({'sourceVerdict':'REJECTED','firstFailure':name})
            receipt.write_text(json.dumps(report,indent=2)+'\n')
            raise SystemExit('Source assertion rejected: '+name)
    before=(OUT/'service.before.ts.txt').read_text()
    candidate=(ROOT/TARGET).read_text()
    need('BASELINE_PIN',sha(before.encode())=='54bbff59b46586120f107472265d116a6754782aea6d632295ecea88983f5ddc')
    need('EXACT_ARCHIVES',candidate==(OUT/'service.expected.ts.txt').read_text()==(OUT/'service.after.ts.txt').read_text())
    report['candidateSourceFailures']=failures(candidate)
    need('NAMED_CANDIDATE_LEXICAL_ASSERTIONS',not report['candidateSourceFailures'])
    restored=candidate.replace(LIST,'',1).replace(BOOLEAN,'',1)
    restored=restored.replace('      requiresPrescriptionCheck &&','      payload.status === \'completed\' &&',1)
    restored=restored.replace('...(requiresPrescriptionCheck\n',"...(payload.status === 'completed'\n",1)
    need('ONLY_LIST_BOOLEAN_AND_TWO_REUSES_CHANGED',restored==before)
    pins=json.loads((OUT/'protected-files.before.json').read_text())
    after={name:sha((ROOT/name).read_bytes()) if (ROOT/name).is_file() else 'MISSING' for name in pins}
    changed=[name for name in pins if after[name]!=pins[name]]
    report['changedProtectedFiles']=changed
    need('ONLY_OWNED_ISOLATED_SERVICE_CHANGED',changed==[TARGET])
    variants=[('baseline',before,'ONE_EXACT_PRIVATE_TARGET_LIST')]
    for target in ('packed','ready_for_pickup','out_for_delivery','completed'):
        altered=LIST.replace("  '"+target+"',\n",'',1)
        variants.append(('missing_target_'+target,candidate.replace(LIST,altered,1),'ONE_EXACT_PRIVATE_TARGET_LIST'))
    edits=(
        ('accepted_added_to_gate',LIST,LIST.replace("  'packed',","  'accepted',\n  'packed',",1),'ONE_EXACT_PRIVATE_TARGET_LIST'),
        ('completion_only_guard','      requiresPrescriptionCheck &&',"      payload.status === 'completed' &&",'SHARED_GUARD'),
        ('completion_only_cas','...(requiresPrescriptionCheck\n',"...(payload.status === 'completed'\n",'SHARED_CAS'),
        ('gate_from_current_state','PRESCRIPTION_GATED_STATUSES.includes(payload.status)','PRESCRIPTION_GATED_STATUSES.includes(order.status)','ONE_TARGET_DERIVATION'),
        ('unknown_state_admitted',"order.prescriptionStatus !== 'not_required'\n","order.prescriptionStatus !== 'not_required' && order.prescriptionStatus !== undefined\n",'CLOSED_RX_ALLOWLIST'),
        ('broad_eligible_cas','prescriptionStatus: order.prescriptionStatus }',"prescriptionStatus: { $in: ['approved', 'not_required'] } }",'EXACT_OBSERVED_CAS'),
        ('all_gated_targets_consume',"if (payload.status === 'completed') {\n        await this.consumeOrderInventory",'if (requiresPrescriptionCheck) {\n        await this.consumeOrderInventory','COMPLETION_ONLY_CONSUMPTION'),
        ('error_api_changed',"message: 'Prescription approval is required before the order can be completed'","message: 'Prescription required'",'UNCHANGED_ERROR_API'),
    )
    for name,old,new,intended in edits:
        variants.append((name,candidate.replace(old,new,1),intended))
    part=section(candidate)
    sessionless=part.replace('{ new: true, session }\n      );','{ new: true }\n      );',1)
    variants.append(('session_removed',candidate.replace(part,sessionless,1),'SESSION_OPTION'))
    premature=part.replace('      const nextOrder = await this.orderRepo.update(','      await this.consumeOrderInventory(pharmacyId, order.items, session);\n      const nextOrder = await this.orderRepo.update(',1)
    variants.append(('consume_before_cas',candidate.replace(part,premature,1),'CAS_AND_NO_MATCH_BEFORE_INVENTORY'))
    early=candidate.replace(BOOLEAN+GUARD,'',1)
    anchor="    if (\n      ['packed', 'ready_for_pickup', 'out_for_delivery'].includes(payload.status)"
    early=early.replace(anchor,BOOLEAN+GUARD+'\n'+anchor,1)
    variants.append(('gate_before_payment',early,'PAYMENT_BEFORE_RX_BEFORE_EFFECTS'))
    for name,variant,intended in variants:
        rejected=failures(variant)
        report['negativeControls'].append({'name':name,'intended':intended,'rejectedByNamedSourceAssertions':rejected,'variantSha256':sha(variant.encode()),'scope':'in-memory source text only'})
        need('NEGATIVE_CONTROL_'+name,variant!=candidate and intended in rejected)
        need('RESTORED_SOURCE_CONTROL_'+name,not failures(candidate))
    (OUT/'protected-files.after.json').write_text(json.dumps(after,indent=2)+'\n')
    report.update({'sourceVerdict':'ACCEPTED','candidateSha256':sha(candidate.encode()),'protectedFileCount':len(pins),'negativeControlCount':len(variants),'restoredSourceControlCount':len(variants),'scriptSha256':sha(Path(__file__).read_bytes()),'gitMutation':False,'limitations':['Lexical assertions/hashes only; no TypeScript/parser/compiler or app execution.','Source variants/restorations are text controls, not executed status/payment/DB/stock cases.','Type validity/focused behavior remain NOT_RUN pending separate complete C3 admission.','F1 remains HIGH/open; named owner decisions required before additional policy and Rx enablement/release. No answer inferred to the pending names question.']})
    receipt.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({key:report[key] for key in ('sourceVerdict','candidateSha256','protectedFileCount','negativeControlCount','restoredSourceControlCount','runtimeBehavior','F1')}))

if __name__=='__main__': main()

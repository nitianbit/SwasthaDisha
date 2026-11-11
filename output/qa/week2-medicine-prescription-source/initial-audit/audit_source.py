#!/usr/bin/env python3
"""Static candidate/scope audit only; never imports/parses/executes application code."""
import argparse, hashlib, json, stat, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
QA=Path(__file__).resolve().parent
BASE='1db3da7bf90106e1b2f3ef03eec2c9999161286c'
TRANSFORMS=json.loads((QA/'literal-transform.json').read_text())
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def expected():
 result={}
 for name, edits in TRANSFORMS.items():
  source=git('show',BASE+':'+name).decode()
  for old,new in edits:
   assert source.count(old)==1,('AUDIT_ANCHOR',name)
   source=source.replace(old,new)
  result[name]=source
 return result
def audit(candidate):
 wanted=expected()
 for name,text in wanted.items():
  if candidate[name]!=text:return False
 return True
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--expect-baseline-rejection',action='store_true');opts=parser.parse_args()
 actual={name:(ROOT/name).read_text() for name in TRANSFORMS}
 if opts.expect_baseline_rejection:
  assert not audit(actual),'BASELINE_UNEXPECTEDLY_ACCEPTED'
  print(json.dumps({'status':'BASELINE_REJECTED','scope':'SOURCE_DATA_ONLY_NOT_BEHAVIOR_OR_TYPES','sourceFiles':list(TRANSFORMS)}));return
 assert audit(actual),'SOURCE_CANDIDATE_MISMATCH'
 changed=git('diff','--name-only',BASE).decode().splitlines()
 assert sorted(changed)==sorted(TRANSFORMS),'TRACKED_SCOPE'
 untracked=git('ls-files','--others','--exclude-standard').decode().splitlines()
 assert all(name.startswith('output/qa/week2-medicine-prescription-source/') for name in untracked),'UNTRACKED_SCOPE'
 for name in TRANSFORMS:
  st=(ROOT/name).lstat();assert stat.S_ISREG(st.st_mode) and not (ROOT/name).is_symlink() and st.st_nlink==1
  assert git('ls-tree',BASE,'--',name).decode().startswith('100644 ') and stat.S_IMODE(st.st_mode)==0o644
 # Concrete source-declaration weakening checks; no behavior/type claim.
 controls=[('UNFORWARDED_ROLE','req.user?.userType','undefined'),('BODY_SELECTED_ROLE','req.user?.userType','req.body.userType'),('QUERY_SELECTED_ROLE','req.user?.userType','req.query.userType'),('ADMIN_DENIED',"actorUserType !== 'admin'",'true'),('EVERY_ACTOR_ALLOWED',"actorUserType !== 'admin'",'false'),('TRUTHINESS',"Object.prototype.hasOwnProperty.call(data, 'prescriptionRequired')",'Boolean(data.prescriptionRequired)'),('UNCHANGED_BYPASS',"Object.prototype.hasOwnProperty.call(data, 'prescriptionRequired')",'data.prescriptionRequired !== medicine.prescriptionRequired'),('WRONG_FIELD',"call(data, 'prescriptionRequired')","call(data, 'isActive')"),('WRONG_STATUS','status: 422','status: 403'),('WRONG_CODE',"code: 'FORBIDDEN_FIELD'","code: 'FORBIDDEN'"),('LOOKUP_REMOVED','const medicine = await this.medicineRepository.findById(id);','const medicine = {} as IMedicine;')]
 rows=[]
 for ident,old,new in controls:
  candidate=dict(actual);target=next(name for name,text in candidate.items() if old in text);candidate[target]=candidate[target].replace(old,new,1)
  assert not audit(candidate),('WEAKENING_ACCEPTED',ident);rows.append(ident)
 print(json.dumps({'status':'SOURCE_AUDIT_PASS','scope':'SOURCE_DATA_ONLY_NOT_BEHAVIOR_OR_TYPES','literalSourceSensitivities':rows,'sourceSha256':{name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in TRANSFORMS},'applicationExecutions':0,'compilerExecutions':0,'runtime':'NOT_RUN'}))
if __name__=='__main__':main()

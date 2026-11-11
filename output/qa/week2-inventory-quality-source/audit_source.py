#!/usr/bin/env python3
"""Source-byte/scope audit; no application parsing, evaluation or behavior claim."""
import argparse,hashlib,json,stat,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];QA=Path(__file__).resolve().parent
BASE='1db3da7bf90106e1b2f3ef03eec2c9999161286c'
TRANSFORMS=json.loads((QA/'literal-transform.json').read_text());NAME=next(iter(TRANSFORMS))
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT)
def expected():
 text=git('show',BASE+':'+NAME).decode()
 for old,new in TRANSFORMS[NAME]:assert text.count(old)==1; text=text.replace(old,new)
 return text
def audit(text):return text==expected()
def main():
 p=argparse.ArgumentParser();p.add_argument('--expect-baseline-rejection',action='store_true');opts=p.parse_args();text=(ROOT/NAME).read_text()
 if opts.expect_baseline_rejection:
  assert not audit(text);print(json.dumps({'status':'BASELINE_REJECTED','scope':'SOURCE_DATA_ONLY_NOT_BEHAVIOR_OR_TYPES'}));return
 assert audit(text),'SOURCE_CANDIDATE_MISMATCH'
 changed=git('diff','--name-only',BASE).decode().splitlines();assert [n for n in changed if not n.startswith('output/qa/week2-inventory-quality-source/')]==[NAME],'TRACKED_SCOPE'
 untracked=git('ls-files','--others','--exclude-standard').decode().splitlines();assert all(n.startswith('output/qa/week2-inventory-quality-source/') for n in untracked),'UNTRACKED_SCOPE'
 st=(ROOT/NAME).lstat();assert stat.S_ISREG(st.st_mode) and not (ROOT/NAME).is_symlink() and st.st_nlink==1 and stat.S_IMODE(st.st_mode)==0o644;assert git('ls-tree',BASE,'--',NAME).decode().startswith('100644 ')
 controls=[]
 for ordinal,(old,new) in enumerate(TRANSFORMS[NAME]):
  prefix='ADJUST' if ordinal==0 else 'RELEASE'
  for status in ['recalled','quarantined','expired']:
   needle="batch.status !== '"+status+"'";assert new.count(needle)==1
   changed=new.replace(needle,'true');assert not audit(text.replace(new,changed));controls.append(prefix+'_REMOVE_'+status.upper())
  assert not audit(text.replace(new,old));controls.append(prefix+'_GUARD_REMOVED')
  changed=new.replace("batch.status !== 'recalled'","batch.status === 'recalled'");assert not audit(text.replace(new,changed));controls.append(prefix+'_BRANCH_SENSE')
  marker=old.splitlines()[1];inside='  '+marker;assert new.count(inside)==1
  changed=new.replace(inside,'')+'\n'+marker;assert not audit(text.replace(new,changed));controls.append(prefix+'_MARKER_OUTSIDE')
 assert not audit(text.replace(TRANSFORMS[NAME][0][1],TRANSFORMS[NAME][0][0]).replace(TRANSFORMS[NAME][1][1],TRANSFORMS[NAME][1][0]));controls.append('BOTH_GUARDS_REMOVED')
 for ident,old,new in [('ADJUST_NORMAL_TRANSITION','availableQtyAfter === 0','availableQtyAfter < 0'),('RELEASE_EXPIRY_BOUNDARY','batch.expiryDate < today','batch.expiryDate <= today'),('QUANTITY_MATH','document.availableQty += input.quantityDelta;','document.availableQty -= input.quantityDelta;'),('NORMAL_DEPLETED_MARKER',"batch.status === 'depleted' ? new Date() : undefined",'undefined')]:
  assert old in text;assert not audit(text.replace(old,new,1));controls.append(ident)
 print(json.dumps({'status':'SOURCE_AUDIT_PASS','scope':'SOURCE_DATA_ONLY_NOT_BEHAVIOR_OR_TYPES','literalSourceSensitivities':controls,'sourceSha256':{NAME:hashlib.sha256((ROOT/NAME).read_bytes()).hexdigest()},'applicationExecutions':0,'compilerExecutions':0,'runtime':'NOT_RUN'}))
if __name__=='__main__':main()

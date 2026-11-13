// One exact role invocation, separate from preparation and all dependency-free unit checks.
import { readFileSync, lstatSync, writeFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const ROOT=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const HERE=fileURLToPath(new URL('.',import.meta.url));
const AUTHOR='/root/customer_remaining_audit';
const NODE_SHA='27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1';
const RECEIPT='/private/tmp/sd-pharmacy-refill-runtime-approval.json';
const DECISION='APPROVE_ONE_FIXED_PHARMACY_REFILL_API_RUN';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error(code);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
function regular(file,cap=32*1024*1024){const st=lstatSync(file);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=cap,'Operator input shape');return readFileSync(file);}
function git(args){const result=spawnSync('/usr/bin/git',['--no-optional-locks','-c','core.fsmonitor=false',...args],{cwd:ROOT,env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:25000,maxBuffer:1024*1024});need(!result.error&&!result.signal&&result.status===0,'Source readback unavailable');return result.stdout.trim();}
export function validateReceipt(receipt,expected){
  need(exact(receipt,[...Object.keys(expected),'nonce','reviewers'])&&Object.keys(expected).every(key=>receipt[key]===expected[key]),'Exact invocation binding');
  need(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.nonce),'Invocation nonce');
  need(Array.isArray(receipt.reviewers)&&receipt.reviewers.length===2&&new Set(receipt.reviewers.map(row=>row.agent)).size===2&&receipt.reviewers.every(row=>exact(row,['agent','decision'])&&row.agent!==AUTHOR&&/^\/root(?:\/[A-Za-z0-9_]+)*$/.test(row.agent)&&row.decision===DECISION),'Two actual nonauthor invocation decisions');
}
function frozen(commit){
  need(git(['rev-parse','HEAD'])===commit,'Source commit changed');
  const status=git(['status','--porcelain','--untracked-files=all']);
  // Sole generated descriptor: checked by hash/ownership below. No other untracked/modified source is admitted.
  need(status===''||status==='?? test/api-runtime/pharmacy-refill/runtime-template.json','Source checkout changed');
}
export async function requestRun(run,report,save){report.runRequested=true;report.status='RUN_REQUESTED';save();const pending=run();report.runEntered=true;return await pending;}
async function main(){
  need(Object.keys(process.env).every(key=>['PATH','TMPDIR','__CF_USER_TEXT_ENCODING'].includes(key))&&process.env.TMPDIR==='/private/tmp'&&process.env.PATH==='/usr/bin:/bin'&&
    (process.env.__CF_USER_TEXT_ENCODING===undefined||process.env.__CF_USER_TEXT_ENCODING==='0x'+process.getuid().toString(16).toUpperCase()+':0x0:0x0'),'Operator environment');
  need(process.argv.length===2&&process.execArgv.length===0&&process.version==='v24.19.0'&&process.execPath==='/Users/shubham/.nvm/versions/node/v24.19.0/bin/node'&&sha(regular(process.execPath,128*1024*1024))===NODE_SHA,'Pinned operator invocation');
  const meta=lstatSync(RECEIPT);need(meta.uid===process.getuid()&&(meta.mode&0o777)===0o600,'Private invocation receipt');
  const receiptBytes=regular(RECEIPT),receipt=JSON.parse(receiptBytes),templateBytes=regular(join(HERE,'runtime-template.json')),template=JSON.parse(templateBytes);
  const commit=git(['rev-parse','HEAD']);need(template.sourceCommit===commit,'Prepared source differs');
  const expected={schema:'SD-PHARMACY-REFILL-API-INVOCATION-APPROVAL-1',decision:DECISION,sourceRoot:ROOT,sourceCommit:commit,
    operatorSha:sha(regular(fileURLToPath(import.meta.url))),platformSha:sha(regular(join(HERE,'../platform.mjs'))),profileSha:sha(regular(join(HERE,'profile.json'))),
    networkSha:sha(regular(join(HERE,'../../application/app-bundle.mjs'))),templateSha:sha(templateBytes),lockSha:template.lockSha,portsSha:template.portsSha,hostNodeSha:NODE_SHA};
  validateReceipt(receipt,expected);frozen(commit);
  const claim='/private/tmp/sd-pharmacy-refill-once-'+receipt.nonce+'.json';
  writeFileSync(claim,JSON.stringify({sourceCommit:commit,templateSha:expected.templateSha,receiptSha:sha(receiptBytes)})+'\n',{flag:'wx',mode:0o600});
  const reportDirectory=mkdtempSync('/private/tmp/sd-pharmacy-refill-invocation-'),identity=lstatSync(reportDirectory);
  const report={schema:'SD-PHARMACY-REFILL-API-INVOCATION-1',sourceCommit:commit,approvalSha:sha(receiptBytes),templateSha:expected.templateSha,
    status:'CLAIMED_NOT_ENTERED',fixtureHandleReturned:false,runRequested:false,runEntered:false,created:[],cleanup:'NOT_NEEDED'};
  const save=()=>{const st=lstatSync(reportDirectory);need(st.isDirectory()&&!st.isSymbolicLink()&&st.dev===identity.dev&&st.ino===identity.ino,'Operator ownership changed');writeFileSync(join(reportDirectory,'operator-result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});};
  save();writeFileSync(join(reportDirectory,'one-run-approval.json'),receiptBytes,{flag:'wx',mode:0o600});let fixture;
  try{
    const {PHARMACY_REFILL_PROFILE,createPharmacyRefillRuntimeFixture}=await import('../platform.mjs');frozen(commit);
    need(sha(regular(join(HERE,'runtime-template.json')))===expected.templateSha,'Template changed');
    fixture=createPharmacyRefillRuntimeFixture({endpoint:PHARMACY_REFILL_PROFILE.endpoint});report.fixtureHandleReturned=true;report.runId=fixture.runId;report.workspace=fixture.directory;save();
    report.result=await requestRun(()=>fixture.run(),report,save);frozen(commit);report.status='RESULT_PENDING_CLEANUP';save();
  }catch{report.status='FAILED_REVIEW_REQUIRED';process.exitCode=1;}
  finally{
    if(fixture){const state=fixture.describe();report.created=state.resources;if(state.failure)report.failure=state.failure;
      try{report.cleanupReceipt=fixture.dispose();report.cleanup='VERIFIED';}catch{report.cleanup='UNRESOLVED';report.status='UNRESOLVED';process.exitCode=1;}}
    if(report.status==='RESULT_PENDING_CLEANUP'&&report.cleanup==='VERIFIED')report.status='FOCUSED_PHARMACY_REFILL_RESULT_PENDING_INDEPENDENT_REVIEW';
    save();process.stdout.write(JSON.stringify({status:report.status,reportDirectory,runEntered:report.runEntered,createdResources:report.created.length,cleanup:report.cleanup})+'\n');
  }
}
if(fileURLToPath(import.meta.url)===process.argv[1])main().catch(()=>{process.stderr.write('Pharmacy-refill invocation rejected; preserve any exact claim/report for review.\n');process.exitCode=1;});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { captureNetworkDiagnostics, requireThat } from '/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha/test/application/app-bundle.mjs';
const root='/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha';
const source=readFileSync(root+'/test/application/bootstrap.mjs','utf8');
const start=source.indexOf("const networkInterfaces = readdirSync('/sys/class/net').sort();");
const end=source.indexOf('// These precede dynamic scenario imports.');
assert.ok(start>=0 && end>start);
const block=source.slice(start,end);
assert.ok(block.endsWith("assert.deepEqual(networkInterfaces, ['lo']);\n\n"));
const capture=readFileSync(root+'/output/qa/m0-a/app-isolation/activation-1/launcher.stderr.txt','utf8');
const names=[.../actual: \[([\s\S]*?)\]/.exec(capture)[1].matchAll(/'([^']+)'/g)].map((m)=>m[1]);
const results=[];
for(const mode of ['captured','minimal','loopback','unavailable','active']) {
  const listing=mode==='loopback'?['lo']:mode==='captured'?names:['lo',mode==='active'?'eth0':'tunl0'];
  const records=[];let continuation=0;let reads=0;
  const denied=()=>{throw Object.assign(new Error('synthetic denial'),{code:'ERR_ACCESS_DENIED'});};
  const args={assert,readdirSync(path){assert.equal(path,'/sys/class/net');return [...listing];},captureNetworkDiagnostics,
    lstatSync(path){reads++;if(mode==='unavailable')return denied();return {isSymbolicLink:()=>!path.endsWith('/bonding_masters'),isFile:()=>path.endsWith('/bonding_masters'),isDirectory:()=>false};},
    readFileSync(path,encoding){reads++;assert.equal(encoding,'utf8');assert.match(path,/^\/sys\/class\/net\/[^/]+\/(flags|operstate|type)$/);if(mode==='unavailable')return denied();return path.endsWith('/flags')?(mode==='active'?'0x1\n':'0x0\n'):path.endsWith('/operstate')?(mode==='active'?'up\n':'down\n'):'768\n';},
    addressedNetworkInterfaces(){if(mode==='unavailable')return denied();return mode==='active'?{eth0:[{address:'198.51.100.1',family:'IPv4',internal:false}]}:{lo:[{address:'127.0.0.1',family:'IPv4',internal:true}]};},
    Buffer,process:{env:{APP_RUN_ID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},requireThat,
    writeSync(fd,line){assert.equal(fd,2);assert.ok(Buffer.byteLength(line)<=8193);records.push(JSON.parse(line));}}
  const invoke=()=>{vm.compileFunction(block,Object.keys(args))(...Object.values(args));continuation++;};
  if(mode==='loopback'){invoke();assert.equal(records.length,0);assert.equal(reads,0);assert.equal(continuation,1);}
  else{assert.throws(invoke,{code:'ERR_ASSERTION'});assert.equal(records.length,1);assert.equal(records[0].tag,'APP-NET-DIAG-1');assert.equal(records[0].runId,args.process.env.APP_RUN_ID);assert.equal(continuation,0);}
  if(mode==='unavailable')assert.equal(records[0].entries[1].flags.unavailable,'ERR_ACCESS_DENIED');
  if(mode==='active')assert.equal(records[0].addressedInterfaces[0].addresses[0].internal,false);
  results.push({mode,guardRejected:mode!=='loopback',diagnosticRecords:records.length,metadataReads:reads,continuation,allMetadataSynthetic:true});
}
console.log(JSON.stringify({mode:'Actual extracted bootstrap network block with fake read-only readers and same-realm compilation; bootstrap initialization/scenario not evaluated',results,dockerCalls:0,applicationImports:0}));

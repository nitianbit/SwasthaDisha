'use strict';
// Reviewed fixture bytes + explicit fakes only. No driver, packages or app evaluation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fixture = require('./bootstrap.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const baseline = fs.readFileSync(path.join(__dirname, 'baseline-bootstrap.cjs'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, 'bootstrap.cjs'), 'utf8');
const sources = Object.freeze({"6470766a88a09763ffc1047daa5d072611ea8783459c2ac76cc668349f5b1968":"normal","f4a49fcbe8be8063091a4a1b9b76ea9e300a96e7eef19d9ed5192a3297b28690":"premature-full","c2fd4d268c5b126fe8f5cc3ea03ecc7dbdc9432fd3663c2fc30832be4c555552":"namespace-union","d9fe004b28a77da51d52dbeb7fabdf79317a045e59c5a5141e4add96949fb72d":"all-db","5ab2a3a99e0e71a916b8ad3b7455ae3325a21a99ed55544d3164beea98f6308a":"ignored-namespace","6997c02904a44ab57adf5106f6cc127323df9d20bb98ee91ec2d0c87b0b60231":"ignored-client","cde18d1e03bf11060734d829295266e1f6c03252319d9a1b10c4fccad59266a9":"ignored-session","b5c0df6e6d7ad42ce6a025c104150a4ce1824b19813c0cd76723c2cb5602bed0":"changed-lease","dc13fb37f3c03930249188d8a8dff2eece486b6d02777d8782f6a535805a9bbb":"relaxed-reply","70963c3c5e95f0cf9ae8be40050460cfaaee8c3f506c3d1c39c99b8226c35cb0":"swallowed-failure"});
const mode = sources[sha(source)];
assert(mode, 'unreviewed fixture bytes');
assert.equal(sha(baseline), 'f4a49fcbe8be8063091a4a1b9b76ea9e300a96e7eef19d9ed5192a3297b28690');
const oldExpression = "cursor.namespace?.toString() === manifest.database + '.' + collection";
const newExpression = "cursor.namespace?.toString() === (command === 'listCollections'\n        ? manifest.database : manifest.database + '.' + collection)";
if (mode === 'normal') {
  assert.equal(source.split(newExpression).length, 2);
  assert.equal(source.replace(newExpression, oldExpression), baseline);
}
assert(process.permission && !process.permission.has('child') && !process.permission.has('worker') && !process.permission.has('addon'));
assert(!process.env.NODE_OPTIONS);
const ports = JSON.parse(fs.readFileSync(path.join(__dirname, 'ports-manifest.json')));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json')));
const sections = [
  ['  function trackCursor(cursor, command, collection, session, rowLimit) {', '  const array =', '3d0eeb64e6459481674bfb2d5e4ee400b1068a66049bce8d696cbc6166f4492e'],
  ['  const listCollections = driver.Db.prototype.listCollections;', '  const bulkWrite = driver.Collection.prototype.bulkWrite;', 'a2dbc6f5639c86df6dda6b5a462369c06849b365393fea3b7ecba1dd46281002'],
  ['  const listIndexes = driver.Collection.prototype.listIndexes;', '  const find = driver.Collection.prototype.find;', 'b21869de0dda399270ad122199d2757b95aeed1ff4a467d39b4b7684f5047e6d'],
  ['  const find = driver.Collection.prototype.find;', "  for (const name of ['insertOne', 'insertMany', 'updateOne', 'deleteMany']) {", '5282c5a3784a41e030e1b10f3de64dfff9e2d5edecab93222b6200c0c7bcf17d']
];
function slice(text, start, end) {
  assert.equal(text.split(start).length, 2);
  assert.equal(text.split(end).length, 2);
  const a = text.indexOf(start); const b = text.indexOf(end, a);
  assert(b > a); return text.slice(a, b);
}
for (const [start, end, digest] of sections) assert.equal(sha(slice(baseline, start, end)), digest);
const tests = []; const test = (id, action) => tests.push({ id, action });
const denied = action => assert.throws(action, error => /INVENTORY_[A-Z_]+/.test(error.message));
// These small classes represent fake observations; they do not implement BSON.
class FakeLong { constructor(low=0, high=0, unsigned=false) { Object.assign(this,{low,high,unsigned}); } isZero(){return this.low===0&&this.high===0;} toString(){return String(this.low);} static fromBits(...a){return new this(...a);} }
class FakeTimestamp extends FakeLong { constructor(v={i:0,t:0}){super(v.i,v.t,true);} getHighBitsUnsigned(){return this.high;} getLowBitsUnsigned(){return this.low;} }
class FakeBinary { constructor(buffer=Buffer.alloc(16), subtype=4){this.buffer=buffer;this.position=buffer.length;this.sub_type=subtype;} }
class FakeObjectId { constructor(value='a'.repeat(24)){this.value=value;} toHexString(){return this.value;} }
const bson = {Long:FakeLong,Timestamp:FakeTimestamp,Binary:FakeBinary,ObjectId:FakeObjectId};
function harness(text=source, actualWire=null) {
  const database='sd_iq_'+ 'a'.repeat(32); const client={}; const control={id:new FakeBinary()};
  const sessions=new Map([[control,{id:actualWire ? actualWire.ownSession(control,true) : 'held-session'}]]);
  const leases=new Set(); const observed=[]; let closeCalls=0;
  const cursor={client,session:control,namespace:{toString:()=>database},id:new FakeLong(),async close(){closeCalls++;}};
  const wire={expectCursor(owner){observed.push({...owner}); if(actualWire)actualWire.expectCursor(owner);},closeCursor(id){if(actualWire)actualWire.closeCursor(id);}};
  function Db(){} function Collection(){}
  Db.prototype.listCollections=function(){return cursor;};
  Collection.prototype.listIndexes=function(){return cursor;}; Collection.prototype.find=function(){return cursor;};
  const need=(ok,code)=>{if(!ok)throw new Error(code);};
  const context=vm.createContext({client,control,sessions,leases,manifest:{database},wire,phase:'INDEX_SETUP',scope:{transaction:false},actionSession:control,
    driver:{Db,Collection}, need, keys:fixture.keys,
    // Fake JSON equality is deliberately limited to synthetic wrapper filter/options observations.
    same:(a,b)=>JSON.stringify(a)===JSON.stringify(b),
    sessionIdentity:s=>{need(sessions.has(s),'INVENTORY_SESSION');return sessions.get(s).id;},
    ownCollection:c=>{need(c.client===client&&c.dbName===database&&fixture.COLLECTIONS.includes(c.collectionName),'INVENTORY_DATABASE');return c.collectionName;},
    optionsSession:(o,s)=>need(o&&o.session===s&&sessions.has(s)&&!s.hasEnded,'INVENTORY_SESSION')
  },{codeGeneration:{strings:false,wasm:false}});
  const code=sections.map(([a,b])=>slice(text,a,b)).join('\n')+'\nglobalThis.heldTrack=trackCursor;';
  new vm.Script(code,{filename:'reviewed-fixture-slices.cjs'}).runInContext(context,{timeout:1000});
  const db=Object.assign(new Db(),{client,databaseName:database});
  const collection=Object.assign(new Collection(),{client,dbName:database,collectionName:'inventoryitems'});
  const options=()=>({session:control,nameOnly:true,batchSize:100,maxTimeMS:5000});
  return {database,client,control,cursor,leases,observed,context,db,collection,options,closeCalls:()=>closeCalls,
    track:()=>db.listCollections({},options())};
}
function wireHarness() {
  const database='sd_iq_'+ 'a'.repeat(32); const effects=fixture.effectsState();
  const wire=fixture.createWireBoundary({database},ports,cases,bson,effects); const h=harness(source,wire);
  wire.phase('INDEX_SETUP'); h.track();
  const started={requestId:1,commandName:'listCollections',databaseName:database,command:{listCollections:1,filter:{},cursor:{batchSize:100},nameOnly:true,authorizedCollections:false,maxTimeMS:5000,lsid:h.control,$db:database}};
  const reply=(id=0,ns=database+'.$cmd.listCollections',firstBatch=[])=>({requestId:1,commandName:'listCollections',reply:{ok:1,cursor:{id,ns,firstBatch}}});
  return {h,wire,effects,started,reply};
}
test('baseline-db-only-rejected',()=>{const h=harness(baseline);denied(h.track);assert.equal(h.observed.length,0);});
test('creation-db-only-and-special-lease',()=>{const h=harness();assert.equal(h.track(),h.cursor);assert.equal(h.observed.length,1);assert.equal(h.observed[0].collection,'$cmd.listCollections');assert.equal(h.observed[0].command,'listCollections');assert.equal(h.observed[0].rowLimit,3);assert(h.leases.has(h.cursor));});
for(const [tag,alter] of [
  ['special-namespace',h=>h.cursor.namespace={toString:()=>h.database+'.$cmd.listCollections'}],
  ['foreign-namespace',h=>h.cursor.namespace={toString:()=> 'other'}],
  ['missing-namespace',h=>delete h.cursor.namespace],
  ['foreign-client',h=>h.cursor.client={}], ['foreign-session',h=>h.cursor.session={}],
  ['duplicate-lease',h=>h.leases.add(h.cursor)]
]) test('creation-'+tag+'-denied',()=>{const h=harness();alter(h);denied(h.track);assert.equal(h.observed.length,0);});
for(const [tag,alter] of [['phase',h=>h.context.phase='ACTION'],['filter',h=>h.track=()=>h.db.listCollections({foreign:true},h.options())],['options',h=>h.track=()=>h.db.listCollections({},{...h.options(),extra:1})],['control',h=>h.track=()=>h.db.listCollections({},{...h.options(),session:{}})]])
  test('wrapper-'+tag+'-denied',()=>{const h=harness();alter(h);denied(h.track);assert.equal(h.observed.length,0);});
for(const command of ['find','listIndexes']) {
  test(command+'-full-namespace',()=>{const h=harness();h.cursor.namespace={toString:()=>h.database+'.inventoryitems'};h.context.phase=command==='find'?'CASE_SETUP':'INDEX_SETUP';assert.equal(h.collection[command](...(command==='find'?[{}, {session:h.control,batchSize:100,maxTimeMS:5000}]:[{session:h.control,batchSize:100,maxTimeMS:5000}])),h.cursor);});
  for(const [tag,ns] of [['db-only',h=>h.database],['foreign',()=> 'other.inventoryitems']])
    test(command+'-'+tag+'-denied',()=>{const h=harness();h.cursor.namespace={toString:()=>ns(h)};h.context.phase=command==='find'?'CASE_SETUP':'INDEX_SETUP';denied(()=>h.collection[command](...(command==='find'?[{}, {session:h.control,batchSize:100,maxTimeMS:5000}]:[{session:h.control,batchSize:100,maxTimeMS:5000}])));});
}
for(const batch of [[],[{name:'inventoryitems'}]]) test('lazy-special-reply-'+(batch.length?'buffered':'empty'),async()=>{const {h,wire,started,reply}=wireHarness();assert.equal(h.cursor.namespace.toString(),h.database);wire.started(started);wire.succeeded(reply(0,undefined,batch));assert.equal(h.cursor.namespace.toString(),h.database);h.cursor.id=new FakeLong();h.cursor.namespace={toString:()=>h.database+'.$cmd.listCollections'};h.cursor.initialized=true;assert(h.cursor.id.isZero());await h.cursor.close();wire.assertHealthy();wire.assertClosed();assert.equal(h.closeCalls(),1);});
test('close-before-init-keeps-db-only',async()=>{const h=harness();h.track();await h.cursor.close();assert.equal(h.cursor.namespace.toString(),h.database);assert.equal(h.closeCalls(),1);});
for(const [tag,change] of [
  ['db-only',x=>x.reply.cursor.ns='sd_iq_'+'a'.repeat(32)],['foreign',x=>x.reply.cursor.ns='other.$cmd.listCollections'],
  ['nonzero',x=>x.reply.cursor.id=1],['negative-zero',x=>x.reply.cursor.id=-0],['Long',x=>x.reply.cursor.id=new FakeLong()],['Timestamp',x=>x.reply.cursor.id=new FakeTimestamp()],
  ['shape',x=>x.reply.cursor.extra=true],['request',x=>x.requestId=2],['command',x=>x.commandName='find']
]) test('wire-'+tag+'-reply-denied',()=>{const {wire,started,reply}=wireHarness();wire.started(started);const event=reply();change(event);denied(()=>wire.succeeded(event));denied(()=>wire.assertHealthy());});
test('wire-wrong-session-denied',()=>{const {wire,started}=wireHarness();started.command.lsid={id:new FakeBinary(Buffer.alloc(16,1))};denied(()=>wire.started(started));});
test('wire-no-continuation-owner',()=>{const {h,wire,started,reply}=wireHarness();wire.started(started);wire.succeeded(reply());denied(()=>wire.started({requestId:2,commandName:'getMore',databaseName:h.database,command:{getMore:new FakeLong(1),collection:'$cmd.listCollections',lsid:h.control,$db:h.database}}));});
for(const prefix of ['before','after']) for(const [tag,value] of [['undefined',undefined],['null',null],['false',false],['zero',0],['empty',''],['Error',new Error('first')]])
  test('failure-'+prefix+'-'+tag,async()=>{const h=harness();const secondary=new Error('cleanup');h.cursor.close=async()=>{throw secondary;};h.track();h.cursor.hasNext=async()=>{if(prefix==='after'){h.cursor.namespace={toString:()=>h.database+'.$cmd.listCollections'};h.cursor.initialized=true;}throw value;};const budget=fixture.createReadBudget('METADATA',()=>0n);let caught=false;try{await fixture.collectReadCursor(()=>h.cursor,3,budget,h.leases);}catch(error){caught=true;assert.equal(error,value);}assert(caught,'first failure swallowed');assert(!h.leases.has(h.cursor));denied(()=>budget.check());});
for(const [tag,exceed] of [['deadline',b=>b.now=5000000001n],['rows',b=>{for(let i=0;i<101;i++)b.budget.addRow({},false);}],['bytes',b=>b.budget.addRow({value:'x'.repeat(131073)},false)]])
  test('budget-'+tag+'-latches',()=>{const b={now:0n};b.budget=fixture.createReadBudget('METADATA',()=>b.now);if(tag==='deadline'){exceed(b);denied(()=>b.budget.check());}else denied(()=>exceed(b));denied(()=>b.budget.check());});
(async()=>{let completed=0;for(const {id,action} of tests){try{await action();completed++;}catch(error){process.stdout.write(JSON.stringify({schema:'SD-CURSOR-CREATION-PURE-1',status:'FAIL',sourceMode:mode,test:id,completed,failed:1,error:error?.message||'UNKNOWN'})+'\n');process.exitCode=1;return;}}process.stdout.write(JSON.stringify({schema:'SD-CURSOR-CREATION-PURE-1',status:'PASS',sourceMode:mode,checks:completed,failed:0,caseIds:tests.map(t=>t.id),applicationEvaluations:0,packageEvaluations:0,DockerCalls:0})+'\n');})().catch(()=>{process.stdout.write(JSON.stringify({schema:'SD-CURSOR-CREATION-PURE-1',status:'FAIL',failed:1})+'\n');process.exitCode=1;});

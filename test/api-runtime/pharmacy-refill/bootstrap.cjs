'use strict';
// Trusted fixed fixture. No production/package import or connection precedes admission.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const http = require('node:http');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const { types } = require('node:util');
const ROOT = '/workspace'; const ROLE = 'pharmacy-refill-api';
const CASE_IDS = ["ADMISSION", "AUTHENTICATION", "OPERATIONAL_AUTHORITY", "RAW_QUERY", "CALENDAR", "LIMITS", "CURSOR_CANONICAL", "CURSOR_SCOPE", "DUE_SLICE", "SCALAR_FILTERS", "RAW_ROW_SHAPES", "BSON4_POSITIVES", "BSON4_HOSTILE", "DENSE_ARRAY", "DTO_AND_HEADERS", "QUERY_AND_CATALOG", "PERSISTED_RESUME", "PAUSE_AND_COMPATIBILITY", "UPDATE_AUTHORITY", "SENSITIVITY_AND_RESTORATION"];
const CONTROL_IDS = ["OWNER_AND_SCALAR_FENCES_REMOVED", "QUERY_ROW_BOUND_REMOVED", "RAW_QUERY_ALLOWLIST_WEAKENED", "PATIENT_FIELD_LEAKED", "UNDEFINED_RESUME_RESTORED", "SYMBOL_GETTER_GUARD_REGRESSED", "DENSE_ARRAY_GUARD_REGRESSED"];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code) { const error = Error(code); error.fixtureCode = code; throw error; }
const need = (ok, code) => { if (!ok) fail(code); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact = (value,keys) => plain(value) && same(Object.keys(value).sort(),[...keys].sort());
const latch = { unexpected:0, expected:null, observed:0 };
function reject(code) { if(latch.expected===code)latch.observed++;else latch.unexpected=Math.min(2147483647,latch.unexpected+1);fail(code); }
const admit = (ok,code) => { if(!ok)reject(code); };
async function expectAdmission(code, action) {
  need(latch.expected===null,'EXPECTED_ADMISSION_NESTING'); const before=latch.unexpected;latch.expected=code;latch.observed=0;let error;
  try { await action(); } catch(e) { error=e; } finally { latch.expected=null; }
  need(error?.fixtureCode===code && latch.observed===1 && latch.unexpected===before,'EXPECTED_ADMISSION_BOUNDARY');
}
async function expectCaughtAdmission(code,action){
  need(latch.expected===null,'EXPECTED_ADMISSION_NESTING');const before=latch.unexpected;latch.expected=code;latch.observed=0;let value,error;
  try{value=await action();}catch(caught){error=caught;}finally{latch.expected=null;}
  need(error===undefined&&value===null&&latch.observed===1&&latch.unexpected===before,'EXPECTED_NATIVE_CAUGHT_ADMISSION');
}
function regular(root, relative) {
  need(typeof relative==='string' && relative && !path.isAbsolute(relative) && !/[\\\0\r\n]/.test(relative) && relative.split('/').every(p=>p&&p!=='.'&&p!=='..'),'FILE_PATH');
  let current=root;for(const part of relative.split('/')) {current=path.join(current,part);need(!fs.lstatSync(current).isSymbolicLink(),'FILE_SYMLINK');}
  const st=fs.lstatSync(current);need(st.isFile()&&st.nlink===1&&st.size<=32*1024*1024,'FILE_SHAPE');return fs.readFileSync(current);
}
function validateAdmissionData(manifest,plan,ports,observed) {
  need(exact(manifest,['schema','runId','role','database','replicaSet','mongoId','templateSha','files','lockSha','portsSha','sourceCommit']) && manifest.schema==='SD-PHARMACY-REFILL-API-RUN-1' && manifest.role===ROLE &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(manifest.runId) &&
    manifest.database==='sd_api_'+manifest.runId.replaceAll('-','') && manifest.replicaSet==='sd_rs_'+manifest.runId.replaceAll('-','') && /^[a-f0-9]{64}$/.test(manifest.mongoId) && /^[a-f0-9]{40}$/.test(manifest.sourceCommit),'RUN_BINDING');
  need(plain(manifest.files)&&plain(observed)&&same(Object.keys(manifest.files).sort(),Object.keys(observed).sort()),'FILE_SET');let total=0;
  for(const [name,bytes] of Object.entries(observed)) {need(Buffer.isBuffer(bytes)&&bytes.length<=32*1024*1024&&sha(bytes)===manifest.files[name]&&!/(^|\/)\.env(?:\.|$)|\.node$|service.?account.*\.json$/i.test(name),'FILE_HASH');total+=bytes.length;}
  need(total<=256*1024*1024&&Object.keys(observed).length<=20000&&['bootstrap.cjs','scenario.cjs','runtime-plan.json','ports-manifest.json','package-lock.json','network-admission.mjs'].every(name=>Object.hasOwn(observed,name)),'FILE_BOUND');
  need(sha(observed['ports-manifest.json'])===manifest.portsSha&&sha(observed['package-lock.json'])===manifest.lockSha&&plan.schema==='SD-PHARMACY-REFILL-API-PLAN-1'&&plan.role===ROLE&&ports.role===ROLE&&ports.schema==='SD-PHARMACY-REFILL-PORTS-1'&&plan.sourceCommit===manifest.sourceCommit&&plan.lockSha===manifest.lockSha&&plan.portsSha===manifest.portsSha,'PLAN_BINDING');
  need(same(ports.requiredCaseIds,CASE_IDS)&&same(plan.requiredCaseIds,CASE_IDS)&&same(ports.requiredSensitivityIds,CONTROL_IDS)&&same(plan.requiredSensitivityIds,CONTROL_IDS)&&same(plan.models,ports.models)&&ports.models.length===2&&Object.keys(ports.sourcePins).length===19&&ports.cuts.length===3,'FIXED_COUNTS');
  need(same(plan.providerCounterKeys,['logger','unexpected'])&&plan.compilation.status==='TRANSPILE_ONLY_NOT_TYPECHECKED'&&plan.compilation.compiler==='5.9.3'&&same(Object.keys(plan.modules).sort(),['nominal',...CONTROL_IDS].sort()),'PLAN_PROFILE');
  for(const [id,digest] of Object.entries(ports.sourcePins))need(plan.sourceFiles[id]===digest&&plan.phases.nominal.sources[id]===digest,'SOURCE_PIN');
  for(const [phase,map] of Object.entries(plan.modules)) {need(Object.keys(map).length===19&&plan.phases[phase].emittedCount===19,'WHOLE_MODULES');for(const [id,file] of Object.entries(map))need(Object.hasOwn(ports.sourcePins,id)&&file==='compiled/'+phase+'/'+id.replace(/\.ts$/,'.js')&&Object.hasOwn(observed,file),'COMPILED_BINDING');}
  for(const [id,digest] of Object.entries(ports.nativeSourcePins))need(plan.packageGraph.files[id]===digest&&sha(observed[id])===digest,'NATIVE_SOURCE_PROFILE');
  const helperPath='test/api-runtime/disabled-express-template.cjs';
  need(Object.hasOwn(observed,'disabled-express-template.cjs')&&sha(observed['disabled-express-template.cjs'])===ports.disabledExpressTemplateHelperSha256&&plan.sourceFiles[helperPath]===ports.disabledExpressTemplateHelperSha256,'TEMPLATE_HELPER_SOURCE');
  const template=plan.packageGraph.disabledExpressTemplate;
  need(exact(template,['parent','parentSha256','entryParent','entryParentSha256','start','length','canonicalPolicySha256','negativeChecks'])&&template.canonicalPolicySha256===ports.disabledExpressTemplatePolicySha256,'TEMPLATE_POLICY_RECORD');
  for(const [path,hash]of [[template.parent,template.parentSha256],[template.entryParent,template.entryParentSha256]])need(plan.packageGraph.files[path]===hash&&Object.hasOwn(observed,path)&&sha(observed[path])===hash,'TEMPLATE_PARENT_BINDING');
  need(Number.isSafeInteger(template.start)&&template.start>=0&&Number.isSafeInteger(template.length)&&template.length>0&&template.start+template.length<=observed[template.parent].length,'TEMPLATE_CALL_SPAN');
  const expected=["wrong-parent-path","wrong-parent-hash","wrong-View-function-or-params","wrong-engine-guard","wrong-require-or-__express-expression","wrong-mod-target-declaration","moved-to-top-level-or-export-before-three-imports","duplicate-computed-site-or-incoming-view-edge"];
  need(Array.isArray(template.negativeChecks)&&same(template.negativeChecks.map(row=>row.id),expected)&&template.negativeChecks.every(row=>exact(row,['id','detected'])&&row.detected===true),'TEMPLATE_STATIC_CONTROLS');
  need(Object.keys(plan.packageGraph.files).length>0&&Object.keys(plan.packageGraph.files).length<=4096,'PACKAGE_BOUND');
  for(const [id,digest] of Object.entries(plan.packageGraph.files))need(Object.hasOwn(observed,id)&&sha(observed[id])===digest,'PACKAGE_PIN');
  for(const row of plan.packageGraph.absentOptional)need(ports.optionalAbsentEdges.some(x=>same(x,row))&&plan.packageGraph.files[row.parent]===row.parentSha256,'OPTIONAL_EDGE_BINDING');
  need(plan.packageGraph.unreachableComputedEdges.length===1&&plan.packageGraph.unreachableComputedNegativeChecks.length===4&&same(plan.packageGraph.unreachableComputedNegativeChecks.map(row=>row.id),['wrong-parent','wrong-hash','wrong-guard','wrong-expression'])&&plan.packageGraph.unreachableComputedNegativeChecks.every(row=>exact(row,['id','detected'])&&row.detected===true),'DISABLED_EDGE_COUNT');
  const edge=plan.packageGraph.unreachableComputedEdges[0],{start,length,...policy}=edge;
  need(same(policy,ports.unreachableComputedEdge)&&plan.packageGraph.files[edge.parent]===edge.parentSha256&&Number.isSafeInteger(start)&&start>=0&&length===edge.expression.length&&observed[edge.parent].toString('utf8').slice(start,start+length)===edge.expression,'DISABLED_EDGE_BINDING');
  return manifest;
}
function validateEnvironment(env,runtime) {
  const keys=['PATH','NODE_VERSION','YARN_VERSION','HOME','HOSTNAME','NODE_ENV','APP_ROLE','APP_RUN_ID','APP_MANIFEST_SHA'];
  need(plain(env)&&Object.keys(env).every(key=>keys.includes(key))&&!Object.hasOwn(env,'MONGODB_CLIENT_ENCRYPTION_OVERRIDE')&&env.NODE_ENV==='test'&&env.APP_ROLE===ROLE&&runtime.cwd===ROOT&&runtime.version==='v22.23.4'&&runtime.platform==='linux'&&runtime.permission===true,'ENVIRONMENT');
}
function closedNetwork() {
  const ports=new Set(),connect=net.Socket.prototype.connect,listen=net.Server.prototype.listen;
  net.Socket.prototype.connect=function(...args) {let value=args[0];if(Array.isArray(value))value=value[0];const options=plain(value)?value:{port:value,host:typeof args[1]==='string'?args[1]:'localhost'};
    admit(!options.path&&['localhost','127.0.0.1','::1'].includes(options.host||'localhost')&&Number.isInteger(Number(options.port))&&(Number(options.port)===27017||ports.has(Number(options.port))),'DESTINATION_DENIED');return connect.apply(this,args);};
  net.Server.prototype.listen=function(){reject('DOMAIN_LISTEN_DENIED');};tls.connect=()=>reject('TLS_DENIED');const lookup=dns.lookup;
  dns.lookup=(host,...args)=>{admit(['localhost','127.0.0.1','::1'].includes(host),'DNS_DENIED');return lookup.call(dns,host,...args);};
  for(const name of ['resolve','resolve4','resolve6','resolveSrv','resolveTxt','reverse'])dns[name]=()=>reject('DNS_DENIED');return {ports,listen};
}
function loader(manifest,plan,ports,templateHelper) {
  const savedResolve=Module._resolveFilename,savedLoad=Module._load;let loads=0,resolutions=0;
  function resolve(...args){resolutions++;return Reflect.apply(savedResolve,this,args);}
  function load(...args){loads++;return Reflect.apply(savedLoad,this,args);}
  const viewGuard=templateHelper.createExpressViewGuard(ROOT,manifest.files,()=>reject('TEMPLATE_ENGINE_DISABLED'));
  const builtins=new Set(Module.builtinModules.map(s=>s.replace(/^node:/,'')));
  const denied=new Set(['child_process','worker_threads','cluster','vm','inspector','repl','module']);let phase='nominal',cuts=Object.freeze({}),imports=0,lookups=0;const optionalProbes=new Map();
  const canonical=(request,parent)=>{
    if(request.startsWith('@/')) {const base='src1/'+request.slice(2);return [base+'.ts',base+'/index.ts'].find(id=>Object.hasOwn(ports.sourcePins,id));}
    if(request.startsWith('.')&&parent?.filename?.startsWith(ROOT+'/compiled/')) {const source=parent.filename.slice((ROOT+'/compiled/').length).split('/').slice(1).join('/').replace(/\.js$/,'.ts');const base=path.posix.normalize(path.posix.join(path.posix.dirname(source),request));return [base+'.ts',base+'/index.ts'].find(id=>Object.hasOwn(ports.sourcePins,id));}
  };
  function missing(request,parent) {const parentId=parent?.filename?.startsWith(ROOT+'/')?parent.filename.slice(ROOT.length+1):'';const tuple=plan.packageGraph.absentOptional.find(row=>row.parent===parentId&&row.specifier===request);
    if(!tuple)return false;admit(manifest.files[parentId]===tuple.parentSha256,'OPTIONAL_PARENT_DRIFT');const key=parentId+'\0'+request;optionalProbes.set(key,(optionalProbes.get(key)||0)+1);try{resolve.call(Module,request,parent,false);}catch(error){if(error.code==='MODULE_NOT_FOUND')throw error;throw error;}reject('OPTIONAL_UNEXPECTED_PRESENT');}
  const driverEnvironment=()=>admit(!Object.hasOwn(process.env,'MONGODB_CLIENT_ENCRYPTION_OVERRIDE'),'ENCRYPTION_OVERRIDE_ENV');
  Module._resolveFilename=function(request,parent,isMain,options) {viewGuard.resolve(request,parent);driverEnvironment();lookups++;
    const native=request.replace(/^node:/,'');if(builtins.has(native)){admit(!denied.has(native),'BUILTIN_DENIED');return resolve.call(this,request,parent,isMain,options);}
    missing(request,parent);const id=canonical(request,parent);let filename;
    try {filename=id?path.join(ROOT,plan.modules[id.includes('/model/')?'nominal':phase][id]):resolve.call(this,request,parent,isMain,options);}catch{reject('UNDECLARED_MODULE');}
    const relative=path.relative(ROOT,filename).split(path.sep).join('/');admit(!relative.startsWith('../')&&Object.hasOwn(manifest.files,relative)&&(!relative.startsWith('node_modules/')||Object.hasOwn(plan.packageGraph.files,relative)),'UNDECLARED_MODULE');return filename;
  };
  Module._load=function(request,parent,isMain) {return viewGuard.load(request,parent,()=>{driverEnvironment();lookups++;const native=request.replace(/^node:/,'');admit(!builtins.has(native)||!denied.has(native),'BUILTIN_DENIED');if(Object.hasOwn(cuts,request))return cuts[request];return load.call(this,request,parent,isMain);});};
  return {phase(name,bindings){admit(name==='nominal'||CONTROL_IDS.includes(name),'PHASE_DENIED');phase=name;cuts=Object.freeze({...bindings});for(const filename of Object.keys(require.cache))if(filename.startsWith(ROOT+'/compiled/')&&!filename.includes('/model/'))delete require.cache[filename];},
    get(id){admit(Object.hasOwn(ports.sourcePins,id),'DOMAIN_ROOT_DENIED');imports++;return require(path.join(ROOT,plan.modules[id.includes('/model/')?'nominal':phase][id]));},
    assertView(){return viewGuard.assertSealed();},get savedForwards(){return Object.freeze({loads,resolutions});},
    get name(){return phase;},get imports(){return imports;},get lookups(){return lookups;},get optionalProbes(){return [...optionalProbes].map(([key,count])=>{const [parent,specifier]=key.split('\0');return{parent,specifier,count};});}};
}
let stage='ADMISSION';let activeCheckpoint=null;
async function main(){
  validateEnvironment({...process.env},{cwd:process.cwd(),version:process.version,platform:process.platform,permission:!!process.permission});
  const admission=regular(ROOT,'.admission.json');need(sha(admission)===process.env.APP_MANIFEST_SHA,'ADMISSION_HASH');const manifest=JSON.parse(admission),observed={};
  need(process.env.APP_RUN_ID===manifest.runId,'RUN_ENVIRONMENT');const walk=(directory,prefix='')=>{for(const name of fs.readdirSync(directory)){const full=path.join(directory,name),st=fs.lstatSync(full);need(!st.isSymbolicLink(),'FILE_LINK');if(st.isDirectory())walk(full,prefix+name+'/');else if(prefix+name!=='.admission.json')observed[prefix+name]=regular(ROOT,prefix+name);}};walk(ROOT);
  const ports=JSON.parse(observed['ports-manifest.json']),plan=JSON.parse(observed['runtime-plan.json']);validateAdmissionData(manifest,plan,ports,observed);
  const networkModule=await import(pathToFileURL(ROOT+'/network-admission.mjs').href);
  const networkAdmission=networkModule.admitNetwork({list:()=>fs.readdirSync('/sys/class/net'),entryType:p=>networkModule.entryKind(fs.lstatSync(p)),readText:p=>fs.readFileSync(p,'utf8'),addresses:os.networkInterfaces,report:()=>fail('NETWORK_ADMISSION')},manifest.runId);
  for(const fn of [()=>fs.readFileSync('/etc/passwd'),()=>fs.writeFileSync(ROOT+'/unadmitted','x')]){let denied=false;try{fn();}catch(error){denied=error.code==='ERR_ACCESS_DENIED';}need(denied,'FILESYSTEM_CANARY');}
  need(!process.permission.has('child')&&!process.permission.has('worker')&&!process.permission.has('addon'),'PROCESS_PERMISSION');
  const [canary]=await Promise.allSettled([fetch('http://192.0.2.1:8080/',{signal:AbortSignal.timeout(1500)})]);need(networkModule.egressCanaryBlocked(canary),'EGRESS_CANARY');
  need(Module.builtinModules.includes('punycode'),'PUNYCODE_NATIVE_PROFILE');
  const templateHelper=require(ROOT+'/disabled-express-template.cjs');need(templateHelper.EXPRESS_VIEW_POLICY_SHA256===ports.disabledExpressTemplatePolicySha256,'TEMPLATE_POLICY_BINDING');
  const proof=plan.packageGraph.disabledExpressTemplate,policy=templateHelper.EXPRESS_VIEW_POLICY;
  need(proof.parent===policy.parent&&proof.parentSha256===policy.parentSha256&&proof.entryParent===policy.entryParent&&proof.entryParentSha256===policy.entryParentSha256&&proof.length===policy.expression.length&&observed[proof.parent].toString('utf8').slice(proof.start,proof.start+proof.length)===policy.expression,'TEMPLATE_EXACT_SITE');
  const network=closedNetwork(),domain=loader(manifest,plan,ports,templateHelper);
  require('reflect-metadata');const express=require('express');const ActualView=domain.assertView();
  const jwt=require('jsonwebtoken'),typedi=require('typedi'),mongoose=require('mongoose');
  need(mongoose.version==='6.13.8'&&mongoose.modelNames().length===0,'NATIVE_PROFILE');mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);mongoose.set('bufferCommands',false);
  const native=mongoose.mongo,secret=crypto.randomBytes(32).toString('hex'),commands=[],sessions=new Set(),loggerRecords=[],dueReads=[];
  const names=new Set(ports.models.map(m=>m.collection));let current,commandBytes=0,bootstrapWindow=false,connectCalls=0,openUriCalls=0,clientConnectCalls=0,admittedClient;
  const counters={logger:0,get unexpected(){return latch.unexpected;}};
  class ClosedPharmacyCustomerService{}
  for(const method of ['createCustomer','getCustomers','updateNotes','getLink','assertLinked','ensureLinked'])ClosedPharmacyCustomerService.prototype[method]=()=>reject('PHARMACY_CUSTOMER_DEPENDENCY_DENIED');
  const logger=Object.freeze(Object.fromEntries(['error','warn','info','debug'].map(method=>[method,(...args)=>{
    admit(args.length>=1&&args.length<=2&&typeof args[0]==='string'&&args[0].length<=512&&(args.length===1||(plain(args[1])&&Reflect.ownKeys(args[1]).length===0)),'LOGGER_SHAPE');admit(loggerRecords.length<4096,'LOGGER_BOUND');loggerRecords.push(args[0]);counters.logger++;
  }])));
  const cuts={'@/config/config':{CONFIG:Object.freeze({JWT_SECRET_KEY:secret})},'@/services/logger':{__esModule:true,default:logger},'@/modules/pharmacyCustomers/services':{PharmacyCustomerService:ClosedPharmacyCustomerService}};
  const fixedConnection=mongoose.connection,uri='mongodb://127.0.0.1:27017/'+manifest.database+'?replicaSet='+manifest.replicaSet+'&directConnection=true';
  const connectOptions=Object.freeze({autoCreate:false,autoIndex:false,bufferCommands:false,directConnection:true,retryReads:false,maxPoolSize:2,serverSelectionTimeoutMS:2000,connectTimeoutMS:1000,socketTimeoutMS:5000,waitQueueTimeoutMS:1000,monitorCommands:true});
  const optionKeys=Reflect.ownKeys(connectOptions);
  function fixedOptions(value){if(!plain(value))return false;const keys=Reflect.ownKeys(value);return keys.length===optionKeys.length&&keys.every(k=>typeof k==='string'&&optionKeys.includes(k))&&optionKeys.every(k=>{const d=Object.getOwnPropertyDescriptor(value,k);return d&&'value'in d&&d.enumerable&&d.value===connectOptions[k];});}
  const connect=mongoose.connect.bind(mongoose);mongoose.connect=(value,options)=>{admit(value===uri,'URI_DENIED');admit(fixedOptions(options),'CONNECTION_OPTIONS_DENIED');admit(bootstrapWindow&&connectCalls===0,'CONNECT_WINDOW_DENIED');connectCalls++;return connect(value,options);};
  mongoose.createConnection=()=>reject('SECOND_CONNECTION');const openUri=mongoose.Connection.prototype.openUri;
  mongoose.Connection.prototype.openUri=function(value,options){admit(this===fixedConnection,'CONNECTION_IDENTITY_DENIED');admit(value===uri,'URI_DENIED');admit(fixedOptions(options),'CONNECTION_OPTIONS_DENIED');admit(bootstrapWindow&&openUriCalls===0,'CONNECT_WINDOW_DENIED');openUriCalls++;return openUri.call(this,value,options);};
  const clientConnect=native.MongoClient.prototype.connect,clientDb=native.MongoClient.prototype.db,dbCollection=native.Db.prototype.collection,startSession=native.MongoClient.prototype.startSession,dbCommand=native.Db.prototype.command;
  function knownClient(client){return client===admittedClient&&client===fixedConnection.getClient();}
  native.MongoClient.prototype.startSession=function(...args){admit(knownClient(this),'CLIENT_IDENTITY_DENIED');const session=startSession.apply(this,args);sessions.add(session);return session;};
  native.MongoClient.prototype.db=function(name,options){admit(knownClient(this),'CLIENT_IDENTITY_DENIED');admit((name||this.options?.dbName)===manifest.database,'DATABASE_DENIED');return clientDb.call(this,name,options);};
  native.Db.prototype.collection=function(name,options){admit(knownClient(this.s?.client)&&this.databaseName===manifest.database&&names.has(name),'COLLECTION_DENIED');return dbCollection.call(this,name,options);};
  mongoose.Connection.prototype.useDb=function(){reject('SECOND_CONNECTION');};
  const metadataCursors=new Map();
  function commandAdmission(command){const name=Object.keys(command)[0];const admin=['hello','ismaster','isMaster','ping','endSessions','commitTransaction','abortTransaction'].includes(name);if(admin)return;
    if(name==='explain'){admit(command.explain?.find==='pharmacysubscriptions'&&command.verbosity==='executionStats'&&command.maxTimeMS===2000,'EXPLAIN_DENIED');return;}
    if(name==='listCollections'){admit(command.nameOnly===false&&command.cursor?.batchSize===16,'CATALOG_COMMAND_DENIED');return;}
    if(name==='getMore'){const key=command.getMore.toString();admit(metadataCursors.get(key)===command.collection,'CURSOR_DENIED');return;}
    if(name==='killCursors'){admit(Array.isArray(command.cursors)&&command.cursors.every(id=>metadataCursors.get(id.toString())===command.killCursors),'CURSOR_DENIED');return;}
    admit(['find','insert','update','delete','create','createIndexes','listIndexes','findAndModify'].includes(name)&&names.has(command[name]),'COMMAND_DENIED');
    if(name==='listIndexes')admit(command.includeIndexBuildInfo===true&&command.cursor?.batchSize===16,'CATALOG_COMMAND_DENIED');
  }
  native.Db.prototype.command=function(command,options,...rest){admit(knownClient(this.s?.client)&&this.databaseName===manifest.database,'DATABASE_DENIED');commandAdmission(command);if(options?.session)admit(sessions.has(options.session),'SESSION_DENIED');return dbCommand.call(this,command,options,...rest);};
  native.MongoClient.prototype.connect=function(...args){admit(this===fixedConnection.getClient()&&(!admittedClient||admittedClient===this),'CLIENT_IDENTITY_DENIED');admit(this.s?.url===uri,'DRIVER_URI_DENIED');
    const supplied=Object.getOwnPropertyDescriptor(this,'options');admit(!supplied||'value'in supplied,'DRIVER_OPTIONS_DENIED');const value=supplied?supplied.value:this.options;admit(plain(value),'DRIVER_OPTIONS_DENIED');const effective={dbName:manifest.database,replicaSet:manifest.replicaSet,directConnection:true,retryReads:false,maxPoolSize:2,minPoolSize:0,serverSelectionTimeoutMS:2000,connectTimeoutMS:1000,socketTimeoutMS:5000,waitQueueTimeoutMS:1000,monitorCommands:true};
    for(const [key,expected]of Object.entries(effective)){const d=Object.getOwnPropertyDescriptor(value,key);admit(d&&'value'in d&&d.value===expected,'DRIVER_OPTIONS_DENIED');}
    for(const key of ['credentials','autoEncryption','proxyHost','proxyPort']){const d=Object.getOwnPropertyDescriptor(value,key);admit(!d||('value'in d&&d.value===undefined),'DRIVER_OPTIONS_DENIED');}
    for(const key of ['tls','ssl']){const d=Object.getOwnPropertyDescriptor(value,key);admit(!d||('value'in d&&d.value!==true),'DRIVER_OPTIONS_DENIED');}
    const compression=Object.getOwnPropertyDescriptor(value,'compressors');admit(compression&&'value'in compression,'DRIVER_OPTIONS_DENIED');const array=compression.value;
    admit(Array.isArray(array)&&!types.isProxy(array)&&Object.getPrototypeOf(array)===Array.prototype,'DRIVER_OPTIONS_DENIED');const keys=Reflect.ownKeys(array),entry=Object.getOwnPropertyDescriptor(array,'0'),length=Object.getOwnPropertyDescriptor(array,'length');admit(keys.length===2&&keys[0]==='0'&&keys[1]==='length'&&entry&&'value'in entry&&entry.enumerable&&entry.value==='none'&&length&&'value'in length&&length.value===1,'DRIVER_OPTIONS_DENIED');
    admit(bootstrapWindow&&clientConnectCalls===0,'CONNECT_WINDOW_DENIED');admittedClient=this;clientConnectCalls++;
    this.on('commandStarted',event=>{const command=event.command,name=event.commandName;const admin=['hello','ismaster','isMaster','ping','endSessions','commitTransaction','abortTransaction'].includes(name);admit(event.databaseName===manifest.database||(event.databaseName==='admin'&&admin),'COMMAND_DATABASE');commandAdmission(command);
      const bytes=native.BSON.serialize(command);commandBytes+=bytes.length;admit(commands.length<ports.limits.commandRecords&&commandBytes<=ports.limits.commandBytes,'COMMAND_BOUND');commands.push({name,phase:domain.name,database:event.databaseName,command:native.BSON.deserialize(bytes)});
    });return clientConnect.apply(this,args);
  };
  const queryExec=mongoose.Query.prototype.exec;
  mongoose.Query.prototype.exec=async function(...args){const isDue=this.model?.modelName==='PharmacySubscription'&&this.op==='find'&&!!this.getFilter().$expr;const rows=await queryExec.apply(this,args);if(!isDue)return rows;
    dueReads.push({phase:domain.name,count:rows.length,filter:this.getFilter(),projection:this.projection(),options:this.getOptions()});need(dueReads.length<=2048,'DUE_READ_BOUND');return current?.replyFault?current.replyFault(rows):rows;
  };
  async function endPhase(){if(current){network.ports.delete(current.port);current.server.closeAllConnections();await new Promise((resolve,reject)=>current.server.close(error=>error?reject(error):resolve()));current=undefined;}}
  async function phase(name='nominal'){const priorStage=stage;await endPhase();typedi.Container.reset();domain.phase(name,cuts);stage='ROUTER_IMPORT';typedi.Container.set(ClosedPharmacyCustomerService,new ClosedPharmacyCustomerService());
    const router=domain.get('src1/modules/pharmacySubscriptions/routes/index.ts').default,auth=domain.get('src1/modules/middleware/auth.ts'),errorHandler=domain.get('src1/modules/middleware/errorHandler.ts').errorHandler;
    const service=typedi.Container.get(domain.get('src1/modules/pharmacySubscriptions/services/index.ts').PharmacySubscriptionService),repository=typedi.Container.get(domain.get('src1/modules/pharmacySubscriptions/repository/index.ts').PharmacySubscriptionRepository),Controller=domain.get('src1/modules/pharmacySubscriptions/controller/index.ts').PharmacySubscriptionController;
    const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));app.use('/api/v1/pharmacy-subscriptions',auth.authenticate,router);app.use(errorHandler);
    need(same(mongoose.modelNames().sort(),ports.models.map(m=>m.name).sort())&&ports.models.every(m=>mongoose.model(m.name).db===fixedConnection&&mongoose.model(m.name).collection.name===m.collection),'MODEL_CLOSURE');
    const server=http.createServer(app);await new Promise((resolve,reject)=>{server.once('error',reject);network.listen.call(server,{host:'127.0.0.1',port:0},resolve);});const port=server.address().port;network.ports.add(port);
    current={name,server,port,app,service,repository,controller:new Controller(),validation:domain.get('src1/modules/pharmacySubscriptions/validation/index.ts'),replyFault:null,
      token:(id,pharmacyId,extra={})=>jwt.sign({_id:String(id),pharmacyId:String(pharmacyId),userType:'pharmacy',...extra},secret,Object.hasOwn(extra,'exp')?{}:{expiresIn:'5m'}),wrongKey:(id,pharmacyId)=>jwt.sign({_id:String(id),pharmacyId:String(pharmacyId),userType:'pharmacy'},crypto.randomBytes(32).toString('hex'),{expiresIn:'5m'})};stage=priorStage;return current;
  }
  async function catalog(){const start=performance.now(),session=admittedClient.startSession({causalConsistency:false});let bytes=0,count=0,calls=0;const owned=[];
    const call=async command=>{need(++calls<=12&&performance.now()-start<5000,'CATALOG_BOUND');const result=await fixedConnection.db.command(command,{session,promoteLongs:false});bytes+=native.BSON.calculateObjectSize(result);need(bytes<=262144,'CATALOG_BOUND');return result;};
    const rows=async(command,allowed)=>{let reply=await call(command),result=[];for(;;){need(reply.cursor&&typeof reply.cursor.ns==='string'&&reply.cursor.ns.startsWith(manifest.database+'.'),'CATALOG_NAMESPACE');const collection=reply.cursor.ns.slice(manifest.database.length+1);need(allowed.includes(collection),'CATALOG_NAMESPACE');const batch=reply.cursor.firstBatch??reply.cursor.nextBatch;need(Array.isArray(batch),'CATALOG_BATCH');result.push(...batch);count+=batch.length;need(count<=64,'CATALOG_BOUND');const id=reply.cursor.id;need(id&&typeof id.toString==='function','CATALOG_CURSOR');if(id.toString()==='0')break;metadataCursors.set(id.toString(),collection);owned.push([id,collection]);reply=await call({getMore:id,collection,batchSize:16});metadataCursors.delete(id.toString());}return result;};
    try{const collections=await rows({listCollections:1,filter:{},nameOnly:false,cursor:{batchSize:16},maxTimeMS:1000},['$cmd.listCollections']);need(collections.length===2&&new Set(collections.map(row=>row.name)).size===2&&collections.every(row=>row.type==='collection'&&names.has(row.name)&&row.info?.uuid instanceof native.Binary&&row.info.uuid.sub_type===4&&row.info.uuid.position===16&&row.info.uuid.buffer.length===16&&plain(row.options)&&(!row.options.collation||row.options.collation.locale==='simple')),'CATALOG_COLLECTION');const indexes={};
      for(const name of names){const raw=await rows({listIndexes:name,includeIndexBuildInfo:true,cursor:{batchSize:16},maxTimeMS:1000},[name]);need(raw.every(row=>exact(row,['spec'])&&plain(row.spec)&&Object.keys(row.spec).every(key=>['v','key','name','unique','collation','ns'].includes(key))&&row.spec.v===2&&typeof row.spec.name==='string'&&plain(row.spec.key)&&Object.values(row.spec.key).every(value=>value===1||value===-1)&&(!row.spec.collation||row.spec.collation.locale==='simple')),'CATALOG_FINISHED_INDEX');const specs=raw.map(row=>row.spec);for(const expected of ports.indexes.filter(i=>i.collection===name)){const found=specs.filter(i=>i.name===expected.name);need(found.length===1&&same(found[0].key,expected.key)&&(expected.name==='_id_'?found[0].unique!==false:expected.unique?found[0].unique===true:found[0].unique!==true),'CATALOG_INDEX');}need(!specs.some(i=>same(i.key,{pharmacyId:1,isActive:1,nextRefillDate:1,_id:1})),'NO_CAPACITY_INDEX_CLAIM');indexes[name]=specs;}return {collections,indexes};
    }finally{for(const [id,collection]of owned)if(metadataCursors.has(id.toString())){await call({killCursors:collection,cursors:[id]});metadataCursors.delete(id.toString());}await session.endSession();need(session.hasEnded&&metadataCursors.size===0&&performance.now()-start<5000,'CATALOG_CLEANUP');}
  }
  let result,primary;
  try{await phase();stage='OWNED_DATABASE_CONNECT';bootstrapWindow=true;try{await mongoose.connect(uri,{...connectOptions});}finally{bootstrapWindow=false;}need(connectCalls===1&&openUriCalls===1&&clientConnectCalls===1&&knownClient(fixedConnection.getClient()),'SOLE_CLIENT');
    const hello=await fixedConnection.db.command({hello:1});need(hello.isWritablePrimary&&hello.setName===manifest.replicaSet,'OWNED_REPLICA_SET');for(const m of ports.models)await fixedConnection.db.createCollection(m.collection);for(const index of ports.indexes.filter(i=>i.name!=='_id_'))await fixedConnection.db.collection(index.collection).createIndex(index.key,{name:index.name});
    stage='API_SCENARIOS';result=await require(ROOT+'/scenario.cjs').run({get current(){return current;},phase,catalog,ports,plan,manifest,observed,validateAdmissionData,validateEnvironment,expectAdmission,domain,ActualView,network,mongoose,native,http,fs,performance,need,sha,same,crypto,jwt,counters,commands,dueReads,loggerRecords,sessions,uri,connectOptions,connection:fixedConnection,get client(){return admittedClient;},get nativeEntries(){return{connectCalls,openUriCalls,clientConnectCalls};},checkpoint:id=>{need(id===null||CASE_IDS.includes(id)||CONTROL_IDS.includes(id),'CHECKPOINT_ID');activeCheckpoint=id;}});
  }catch(error){primary=error;}
  try{await endPhase();}catch(error){primary??=error;}for(const session of sessions)if(!session.hasEnded)try{await session.endSession();}catch(error){primary??=error;}try{await mongoose.disconnect();}catch(error){primary??=error;}
  if(primary)throw primary;need(result&&result.failed===0&&result.skipped===0&&latch.unexpected===0,'SCENARIO_RESULT');
  process.stdout.write(JSON.stringify({schema:'SD-PHARMACY-REFILL-API-RESULT-1',runId:manifest.runId,role:ROLE,database:manifest.database,replicaSet:manifest.replicaSet,sourceCommit:manifest.sourceCommit,domainScope:'FOCUSED_PHARMACY_REFILL',admissionPassed:true,networkAdmission,egressBlocked:true,filesystemCanariesPassed:true,failed:0,skipped:0,cases:result.cases,sensitivity:result.sensitivity,providerSummary:counters})+'\n');
}
if(require.main===module)main().catch(error=>{process.stdout.write(JSON.stringify({schema:'SD-PHARMACY-REFILL-API-FAILURE-1',stage,code:typeof error?.fixtureCode==='string'?error.fixtureCode:stage==='API_SCENARIOS'&&activeCheckpoint?activeCheckpoint:'RUNTIME_FIXTURE_FAILED',errorType:'Error',fieldNames:[],failed:1,skipped:0})+'\n');process.exitCode=1;});
module.exports={validateAdmissionData,validateEnvironment,CASE_IDS,CONTROL_IDS,sha,need,exact,same};

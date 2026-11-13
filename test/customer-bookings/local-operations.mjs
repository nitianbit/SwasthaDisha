/** Complete ordinary-booking local-effects policy and orchestration against recording model/session adapters.
 * This is NOT Mongoose/MongoDB/HTTP/provider integration or native transaction/concurrency evidence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../../', import.meta.url);
const paths = {
  local: 'src1/modules/bookings/services/localOperations.ts', booking: 'src1/modules/bookings/services/index.ts',
  payment: 'src1/modules/payment/services/index.ts', lifecycle: 'src1/modules/bookings/utils/lifecycle.ts',
  cutoff: 'src1/modules/common/utils/cancellationWindow.ts',
};
const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, readFileSync(new URL(path, root), 'utf8')]));
const allowedImports = {
  local: ['crypto','mongoose','@/modules/bookings/model','@/modules/slots/model','@/modules/payment/model','@/modules/coupon/model','@/modules/wallet/model','@/modules/common/types','@/modules/bookings/types','@/modules/payment/types','@/modules/bookings/utils/lifecycle','@/modules/common/utils/dateUtils'],
  booking: ["@/modules/bookings/repository", "@/modules/bookings/types", "@/modules/common/types", "@/modules/common/utils/dateUtils", "@/modules/specialists/services", "@/modules/wellnessPackages/services", "@/modules/notification/services", "@/modules/slots/services", "typedi", "@/modules/coupon/services", "@/modules/payment/services", "@/modules/payment/repository", "@/modules/bookings/services/bookingReminderScheduler", "@/modules/wallet/repository", "@/modules/slots/repository", "@/modules/user/repository", "@/modules/email/services", "@/modules/meet/service", "@/modules/specialists/repository", "@/modules/bookings/utils/lifecycle", "./localOperations", "@/modules/common/utils/cancellationWindow"],
  payment: ["crypto", "mongoose", "razorpay", "typedi", "@/config/config", "@/modules/common/types", "@/modules/payment/repository", "@/modules/bookings/repository", "@/modules/externalBookings/repository", "@/modules/bookings/services/labstack", "@/modules/bookings/services/healthians", "@/modules/externalBookings/services/externalBookingPaymentFinalize", "@/modules/wallet/repository", "@/modules/pharmacyWallet/repository", "@/modules/coupon/services", "@/modules/common/utils/dateUtils", "@/modules/bookings/services/bookingReminderScheduler", "@/services/logger", "@/modules/user/repository", "@/modules/email/services", "@/modules/bookings/types", "@/modules/externalBookings/types", "@/modules/pharmacyOrders/repository", "@/modules/pharmacyOrders/types", "@/modules/pharmacyOrders/prescriptionCommerce", "@/modules/pharmacyMedicines/repository", "@/modules/pharmacyInventory/services", "@/modules/pharmacyOrders/services/sideEffects", "@/modules/specialists/repository", "@/modules/slots/repository", "@/modules/meet/service", "@/modules/externalBookings/emailTemplates", "@/modules/bookings/services/localOperations", "@/modules/externalBookings/services/localOperations", "@/modules/wallet/services/localOperations", "@/modules/common/utils/mongoErrors", "@/modules/payment/types"],
  lifecycle: ['@/modules/bookings/types'], cutoff: ['@/modules/common/types'],
};
const exportsFor = { local: '{ BookingLocalOperations, bookingMoneyPaise }', booking: 'BookingService', payment: 'PaymentService', lifecycle: 'buildBookingLifecyclePatch', cutoff: '{ parseAppointment, enforceUserCancellationWindow }' };
const clone = value => structuredClone(value);
const json = value => JSON.parse(JSON.stringify(value));
const ID = { user:'111111111111111111111111', foreign:'ffffffffffffffffffffffff', slot:'222222222222222222222222', payment:'333333333333333333333333', wallet:'444444444444444444444444', package:'555555555555555555555555', nextSlot:'666666666666666666666666', parent:'777777777777777777777777', latePayment:'888888888888888888888888' };
const actor = { _id: ID.user, userType:'user' };
class AppError extends Error { constructor(details) { super(details.message); Object.assign(this, details); } }
function compile(kind, text, ports) {
  const imports=[];
  let body=text.replace(/^import\s[\s\S]*?;\n/gm, statement => {
    const item=statement.match(/(?:from\s+)?['"]([^'"]+)['"];\s*$/); assert.ok(item,'static import only'); imports.push(item[1]); return '';
  });
  assert.deepEqual(imports,allowedImports[kind],'exact ordered whole-module imports');
  if (kind==='booking'||kind==='payment') { assert.equal(body.match(/^@Service\(\)\n/gm)?.length,1); body=body.replace(/^@Service\(\)\n/m,''); }
  assert.doesNotMatch(body,/\b(?:import|require|eval)\s*\(|\bprocess\./);
  body=body.replace(/\bexport\s+(?=(?:class|function|type|interface)\b)/g,'');
  const context=createContext({...ports},{codeGeneration:{strings:false,wasm:false}});
  const js=stripTypeScriptTypes(body,{mode:'transform',sourceUrl:paths[kind]});
  return new Script(js+'\n;globalThis.Subject = '+exportsFor[kind]+';', {filename:paths[kind]}).runInContext(context,{timeout:1000});
}
const get=(object,path)=>path.split('.').reduce((value,key)=>value?.[key],object);
function put(object,path,value) { const keys=path.split('.');const last=keys.pop();let current=object;for(const key of keys)current=current[key]??={};current[last]=clone(value); }
function type(value) { return value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value==='string'?'string':typeof value==='number'?'double':typeof value; }
function expression(value,row) {
  if(typeof value==='string'&&value.startsWith('$'))return get(row,value.slice(1));
  if(Array.isArray(value))return value.map(item=>expression(item,row));
  if(value&&typeof value==='object') {
    if('$type'in value)return type(expression(value.$type,row));
    if('$eq'in value){const [a,b]=expression(value.$eq,row);return a===b;}
    if('$in'in value){const[a,b]=expression(value.$in,row);return b.includes(a);}
    if('$and'in value)return value.$and.every(item=>expression(item,row));
  }
  return value;
}
function matches(row,query) {
  return Object.entries(query).every(([key,wanted])=>{
    if(key==='$expr')return expression(wanted,row);
    if(key==='$and')return wanted.every(item=>matches(row,item));
    const value=get(row,key);
    if(wanted&&typeof wanted==='object'&&!Array.isArray(wanted))return Object.entries(wanted).every(([operator,test])=>{
      if(operator==='$eq')return value===test;
      if(operator==='$gte')return value>=test;
      if(operator==='$in')return test.includes(value);
      if(operator==='$nin')return !test.includes(value);
      if(operator==='$exists')return (value!==undefined)===test;
      throw Error('Unadmitted query operator '+operator);
    });
    return value===wanted;
  });
}
function apply(row,update) {
  for(const [path,value]of Object.entries(update.$set||{}))put(row,path,value);
  for(const [path,value]of Object.entries(update.$inc||{}))put(row,path,(get(row,path)||0)+value);
}
function fixture(variants=sources,options={}) {
  const state={ tables:{Booking:[],Slot:[{_id:ID.slot,isActive:true,isAvailable:true,date:'20261120',startTime:'10:00 AM',wellnessPackageId:ID.package,currentBookings:0,maxBookings:2}],Payment:[],Coupon:[{_id:'999999999999999999999999',code:'SAVE',currentUsageCount:0}],Wallet:[{_id:ID.wallet,userId:ID.user,isActive:true,balance:1000}],Ledger:[]},clock:Date.UTC(2026,10,13,5),events:[],next:10000,active:null,failLedger:0,failFence:0,retryFirst:false };
  class Clock extends Date { static now(){return state.clock;} constructor(...args){super(...(args.length?args:[state.clock]));} }
  const connection={async startSession(){const session={active:false,ended:false,async withTransaction(work,txOptions){
    assert.equal(txOptions.readConcern.level,'snapshot');assert.equal(txOptions.writeConcern.w,'majority');
    for(let attempt=0;;attempt++){
      const snapshot=clone(state.tables);session.active=true;state.active=session;state.events.push('begin');
      try{const value=await work();if(state.retryFirst){state.retryFirst=false;const error=Error('simulated transient');error.simulatedTransient=true;throw error;}state.events.push('commit');return value;}
      catch(error){state.tables=snapshot;state.events.push('abort');if(error.simulatedTransient&&attempt===0)continue;throw error;}
      finally{session.active=false;state.active=null;}
    }
  },async endSession(){assert.equal(session.active,false);session.ended=true;state.events.push('end');}};return session;}};
  function admitted(session){assert.ok(session&&session===state.active&&session.active&&!session.ended,'every model operation must carry the active owned session');}
  function model(name){
    const api={db:connection};
    function query(action,filter,update,opts={}){
      let session=opts.session,selected=false,limit=Infinity;
      const chain={session(value){session=value;return chain;},select(value){assert.equal(value,'+localEffects');selected=true;return chain;},lean(){return chain;},limit(value){limit=value;return chain;},async exec(){
        admitted(session);state.events.push(name+':'+action+(name==='Booking'?':selected='+selected:''));
        const rows=state.tables[name],index=rows.findIndex(row=>matches(row,filter));
        let result;
        if(action==='find')result=rows.filter(row=>matches(row,filter)).slice(0,limit).map(clone);
        else if(action==='read')result=index<0?null:clone(rows[index]);
        else if(action==='update'||action==='updateOne'){
          if(name==='Booking'&&state.failFence>0){state.failFence--;throw Error('simulated booking fence write failure');}
          if(index<0)result=action==='updateOne'?{acknowledged:true,matchedCount:0}:null;
          else{apply(rows[index],update);result=action==='updateOne'?{acknowledged:true,matchedCount:1}:clone(rows[index]);}
        }
        if(name==='Booking'&&!selected&&result){if(Array.isArray(result))result.forEach(row=>delete row.localEffects);else delete result.localEffects;}
        return result;
      },then(resolve,reject){return chain.exec().then(resolve,reject);}};return chain;
    }
    api.findById=id=>query('read',{_id:String(id)});api.findOne=filter=>query('read',filter);api.find=filter=>query('find',filter);
    api.findOneAndUpdate=(filter,update,opts)=>query('update',filter,update,opts);api.updateOne=(filter,update,opts)=>query('updateOne',filter,update,opts);
    api.create=async(docs,opts)=>{admitted(opts?.session);state.events.push(name+':create');if(name==='Ledger'&&state.failLedger>0){state.failLedger--;throw Error('simulated ledger failure');}return docs.map(data=>{const row={...clone(data),_id:data._id||String(state.next++).padStart(24,'0')};state.tables[name].push(row);return{toObject:()=>clone(row)};});};
    return api;
  }
  const models=Object.fromEntries(['Booking','Slot','Payment','Coupon','Wallet','Ledger'].map(name=>[name,model(name)]));
  if(options.mixedDb)models.Wallet.db={};
  const buildBookingLifecyclePatch=compile('lifecycle',variants.lifecycle,{Date:Clock});
  const cancellationPolicy=compile('cutoff',variants.cutoff,{Date:Clock,AppError});
  let uuid=0;
  const ports={AppError,Date:Clock,randomUUID:()=> 'setup-'+(++uuid),BookingModel:models.Booking,SlotModel:models.Slot,PaymentModel:models.Payment,CouponModel:models.Coupon,WalletModel:models.Wallet,WalletTransactionModel:models.Ledger,buildBookingLifecyclePatch,getTodayYyyymmdd:()=> '20261113'};
  const local=compile('local',variants.local,ports);const ops=new local.BookingLocalOperations();
  const input=(extra={})=>({userId:ID.user,bookingType:'package',wellnessPackageId:ID.package,slotId:ID.slot,bookingDate:'20261120',bookingTime:'10:00 AM',status:'pending',paymentStatus:'pending',price:100,...extra});
  const booking=id=>state.tables.Booking.find(row=>row._id===id);
  const payment=(id,extra={})=>{const row={_id:ID.payment,userId:ID.user,context:'booking',contextId:id,currency:'INR',paymentGateway:'razorpay',status:'created',baseAmount:100,discountAmount:0,finalAmount:100,notes:{walletDeductedAmount:(booking(id)?.localEffects.walletDebitedPaise||0)/100},...extra};state.tables.Payment.push(clone(row));return row;};
  async function prepared(extra={},paymentExtra={}){const draft=await ops.createDraft(input(extra));const row=payment(draft._id,paymentExtra);await ops.attachPayment(draft._id,draft.localEffects.setupToken,row._id);await ops.endSetup(draft._id,draft.localEffects.setupToken,false);return{draft,row};}
  const effects=[];const blocked=new Proxy({}, {get(_target,key){throw Error('Unadmitted dependency '+String(key));}});
  const reminder={async scheduleBookingReminders(){effects.push('schedule');},async clearBookingReminders(){effects.push('clear');if(options.cleanupFailure)throw Error('simulated cleanup failure');}};
  const userRepo={async findById(){return{};}};
  const bookRepo={async findById(id){const row=booking(id);if(!row)return null;const value=clone(row);delete value.localEffects;return value;},async findOne(query){const row=state.tables.Booking.find(row=>matches(row,query));if(!row)return null;const value=clone(row);delete value.localEffects;return value;}};
  const common={...ports,...local,...cancellationPolicy,ExternalBookingLocalOperations: class { constructor(){return blocked;} },WalletLocalOperations: class { constructor(){return blocked;} },console:{error(){effects.push('postcommit-error');}},addDaysToYyyymmdd:()=> '20261121',compareYyyymmdd:(a,b)=>a.localeCompare(b),syncBookingMeet:async({booking})=>{effects.push('sync-meet');return booking;},cancelBookingMeet:async({booking})=>{effects.push('cancel-meet');if(options.cleanupFailure)throw Error('simulated cleanup failure');return booking;},buildPaidBookingEmailContent:()=>{throw Error('unadmitted email builder');}};
  function wholeBookingService(){
    const Subject=compile('booking',variants.booking,common);
    const pay={async createDirectPaidTransaction(data){effects.push('direct');if(options.providerFailure)throw Error('simulated payment setup failure');return payment(data.contextId,{...data,paymentGateway:'internal',status:'paid',currency:'INR'});},async createOrder(data){effects.push('gateway');if(options.providerFailure)throw Error('simulated payment setup failure');const row=payment(data.contextId,{...data,paymentGateway:'razorpay',status:'created',currency:'INR'});return{paymentRecord:row,razorpayOrder:{id:'synthetic-order',currency:'INR'},razorpayKeyId:'synthetic-key'};}};
    const notify={async createBookingCreatedNotification(){effects.push('notify');},async createSpecialistNewBookingNotification(){effects.push('notify-specialist');}};
    const wellness={async getById(){return{_id:ID.package,name:'Package',isActive:true,originalPrice:options.basePrice??100};}};
    const slotService={async getById(id){return clone(state.tables.Slot.find(row=>row._id===id));}};
    const coupon={async validateCoupon(){return{isValid:true,coupon:{code:'SAVE'},discountAmount:options.couponDiscount??0};}};
    const walletRepo={async findByUserId(owner){return clone(state.tables.Wallet.find(row=>row.userId===owner));}};
    const paymentRepo={async findById(id){return clone(state.tables.Payment.find(row=>row._id===id));}};
    return new Subject(bookRepo,wellness,blocked,notify,slotService,coupon,pay,paymentRepo,reminder,walletRepo,blocked,blocked,blocked,userRepo,blocked);
  }
  function wholePaymentService(){const Subject=compile('payment',variants.payment,common);return new Subject(blocked,bookRepo,blocked,blocked,blocked,reminder,blocked,blocked,blocked,blocked,blocked,blocked,blocked,blocked,userRepo,blocked,blocked,blocked,blocked);}
  return{state,ops,input,booking,payment,prepared,money:local.bookingMoneyPaise,wholeBookingService,wholePaymentService,effects,models,options,cancellationPolicy};
}
const checks=[];const check=(name,body)=>checks.push({name,body});
async function denied(promise,code){await assert.rejects(promise,error=>error.code===code);}
const windowNoop=()=>{};
check('creation atomically reserves one matching slot and inserts hidden effects',async variants=>{const f=fixture(variants);const draft=await f.ops.createDraft(f.input());assert.equal(f.state.tables.Slot[0].currentBookings,1);assert.equal(draft.localEffects.heldSlotId,ID.slot);assert.ok(draft.localEffects.setupToken);assert.equal(f.state.tables.Booking.length,1);});
check('last-capacity serial competitors cannot oversell',async variants=>{const f=fixture(variants);f.state.tables.Slot[0].maxBookings=1;await f.ops.createDraft(f.input());await denied(f.ops.createDraft(f.input()),'SLOT_NOT_AVAILABLE');assert.equal(f.state.tables.Booking.length,1);assert.equal(f.state.tables.Slot[0].currentBookings,1);});
for(const [label,patch]of [['date',{bookingDate:'20261121'}],['time',{bookingTime:'11:00 AM'}],['package',{wellnessPackageId:ID.foreign}]])check('slot '+label+' mismatch has zero effect',async variants=>{const f=fixture(variants);await denied(f.ops.createDraft(f.input(patch)),'SLOT_NOT_AVAILABLE');assert.equal(f.state.tables.Booking.length,0);assert.equal(f.state.tables.Slot[0].currentBookings,0);});
check('mixed model connections denied before session allocation',async variants=>{const f=fixture(variants,{mixedDb:true});await denied(f.ops.createDraft(f.input()),'BOOKING_RECONCILIATION_REQUIRED');assert.deepEqual(f.state.events,[]);});
check('active setup blocks cancellation',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());await denied(f.ops.cancel(d._id,actor,'cancel',windowNoop),'BOOKING_SETUP_IN_PROGRESS');assert.equal(f.booking(d._id).status,'pending');});
check('expired setup permits takeover and rejects stale token',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());f.state.clock+=300001;const next=await f.ops.beginSetup(d._id,actor);assert.notEqual(next.localEffects.setupToken,d.localEffects.setupToken);await denied(f.ops.debitWallet(d._id,ID.user,d.localEffects.setupToken,10),'BOOKING_CHANGED');await denied(f.ops.endSetup(d._id,d.localEffects.setupToken,false),'BOOKING_CHANGED');});
check('wallet debit and matching ledger update same transaction',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());assert.equal(await f.ops.debitWallet(d._id,ID.user,d.localEffects.setupToken,40.25),40.25);assert.equal(f.state.tables.Wallet[0].balance,959.75);assert.equal(f.state.tables.Ledger[0].amount,40.25);assert.equal(f.booking(d._id).localEffects.walletDebitedPaise,4025);});
check('debit ledger failure rolls back wallet and allows retry',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());f.state.failLedger=1;await assert.rejects(f.ops.debitWallet(d._id,ID.user,d.localEffects.setupToken,40),/ledger failure/);assert.equal(f.state.tables.Wallet[0].balance,1000);assert.equal(f.state.tables.Ledger.length,0);assert.equal(f.booking(d._id).localEffects.walletDebitedPaise,0);await f.ops.debitWallet(d._id,ID.user,d.localEffects.setupToken,40);assert.equal(f.state.tables.Wallet[0].balance,960);});
check('wallet-funded direct payment confirms and counts coupon once',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());await f.ops.debitWallet(d._id,ID.user,d.localEffects.setupToken,100);f.payment(d._id,{paymentGateway:'internal',status:'paid',finalAmount:0,couponCode:'SAVE'});await f.ops.attachPayment(d._id,d.localEffects.setupToken,ID.payment);await f.ops.endSetup(d._id,d.localEffects.setupToken,false);assert.equal(f.booking(d._id).status,'confirmed');await f.ops.confirmPayment(ID.payment);assert.equal(f.state.tables.Coupon[0].currentUsageCount,1);});
check('gateway payment attaches pending then captured confirmation processes once',async variants=>{const f=fixture(variants);const{draft}=await f.prepared({}, {couponCode:'SAVE'});assert.equal(f.booking(draft._id).paymentStatus,'pending');f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);await f.ops.confirmPayment(ID.payment);assert.equal(f.booking(draft._id).paymentStatus,'paid');assert.equal(f.state.tables.Coupon[0].currentUsageCount,1);assert.equal(f.state.tables.Payment[0].isProcessed,true);});
check('paid cancellation refunds internal wallet and releases coupon and hold once',async variants=>{const f=fixture(variants);const{draft}=await f.prepared({}, {couponCode:'SAVE'});f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);const first=await f.ops.cancel(draft._id,actor,'cancel',windowNoop);assert.equal(first.paymentStatus,'refunded');assert.equal(first.localEffects.refundDestination,'internal_wallet');assert.equal(f.state.tables.Wallet[0].balance,1100);assert.equal(f.state.tables.Ledger.filter(row=>row.transactionType==='refund').length,1);assert.equal(f.state.tables.Slot[0].currentBookings,0);assert.equal(f.state.tables.Coupon[0].currentUsageCount,0);await f.ops.cancel(draft._id,actor,'again',windowNoop);assert.equal(f.state.tables.Wallet[0].balance,1100);assert.equal(f.state.tables.Slot[0].currentBookings,0);assert.equal(f.state.tables.Coupon[0].currentUsageCount,0);});
check('refund ledger failure leaves booking paid then retry settles',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);f.state.failLedger=1;await assert.rejects(f.ops.cancel(draft._id,actor,'cancel',windowNoop),/ledger failure/);assert.equal(f.booking(draft._id).paymentStatus,'paid');assert.equal(f.booking(draft._id).status,'confirmed');assert.equal(f.state.tables.Wallet[0].balance,1000);assert.equal(f.state.tables.Slot[0].currentBookings,1);await f.ops.cancel(draft._id,actor,'retry',windowNoop);assert.equal(f.state.tables.Wallet[0].balance,1100);});
check('final booking fence failure rolls back refund ledger and payment',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);f.state.failFence=1;await assert.rejects(f.ops.cancel(draft._id,actor,'cancel',windowNoop),/fence write failure/);assert.equal(f.state.tables.Wallet[0].balance,1000);assert.equal(f.state.tables.Ledger.length,0);assert.equal(f.state.tables.Payment[0].status,'paid');assert.equal(f.state.tables.Slot[0].currentBookings,1);});
check('simulated transient callback retry cannot duplicate refund',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);f.state.retryFirst=true;await f.ops.cancel(draft._id,actor,'cancel',windowNoop);assert.equal(f.state.tables.Wallet[0].balance,1100);assert.equal(f.state.tables.Ledger.length,1);assert.equal(f.state.tables.Slot[0].currentBookings,0);assert.ok(f.state.events.includes('abort'));});
check('late capture after unpaid cancel refunds without resurrecting or releasing again',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();const before=await f.ops.cancel(draft._id,actor,'cancel',windowNoop);assert.equal(before.paymentStatus,'failed');assert.equal(f.state.tables.Ledger.length,0);f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);await f.ops.confirmPayment(ID.payment);assert.equal(f.booking(draft._id).status,'cancelled');assert.equal(f.booking(draft._id).paymentStatus,'refunded');assert.equal(f.state.tables.Wallet[0].balance,1100);assert.equal(f.state.tables.Ledger.length,1);assert.equal(f.state.tables.Slot[0].currentBookings,0);});
check('wallet-only debit before failed setup is recovered exactly once',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());await f.ops.debitWallet(d._id,ID.user,d.localEffects.setupToken,50);await f.ops.endSetup(d._id,d.localEffects.setupToken,true);await f.ops.cancel(d._id,actor,'cancel',windowNoop);await f.ops.cancel(d._id,actor,'again',windowNoop);assert.equal(f.state.tables.Wallet[0].balance,1000);assert.equal(f.state.tables.Ledger.length,2);});
check('zero-money cancellation never invents refund',async variants=>{const f=fixture(variants);const{draft}=await f.prepared({price:0},{paymentGateway:'internal',status:'paid',baseAmount:0,finalAmount:0});const result=await f.ops.cancel(draft._id,actor,'cancel',windowNoop);assert.equal(result.paymentStatus,'failed');assert.equal(f.state.tables.Ledger.length,0);assert.equal(f.state.tables.Wallet[0].balance,1000);assert.equal(result.lifecycle?.refunded,undefined);});
check('paid cancellation invokes window, unpaid does not',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();let windows=0;await f.ops.cancel(draft._id,actor,'cancel',()=>{windows++;});assert.equal(windows,0);const g=fixture(variants);const p=await g.prepared();g.state.tables.Payment[0].status='paid';await g.ops.confirmPayment(ID.payment);await assert.rejects(g.ops.cancel(p.draft._id,actor,'cancel',()=>{throw Error('window denied');}),/window denied/);assert.equal(g.booking(p.draft._id).status,'confirmed');});
check('foreign customer and unsupported roles cannot cancel',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();await denied(f.ops.cancel(draft._id,{_id:ID.foreign,userType:'user'},'bad',windowNoop),'BOOKING_NOT_FOUND');await denied(f.ops.cancel(draft._id,{_id:ID.user,userType:'pharmacy'},'bad',windowNoop),'FORBIDDEN');assert.equal(f.booking(draft._id).status,'pending');});
check('legacy missing local state cannot be guessed',async variants=>{const f=fixture(variants);f.state.tables.Booking.push({_id:ID.parent,...f.input()});await denied(f.ops.cancel(ID.parent,actor,'bad',windowNoop),'BOOKING_RECONCILIATION_REQUIRED');assert.equal(f.state.tables.Wallet[0].balance,1000);});
check('completed booking cannot cancel',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();f.booking(draft._id).status='completed';await denied(f.ops.cancel(draft._id,actor,'bad',windowNoop),'BOOKING_COMPLETED');});
check('payment provenance and paise mismatch deny attachment',async variants=>{for(const patch of [{userId:ID.foreign},{currency:'USD'},{contextId:ID.foreign},{finalAmountPaise:1}]){const f=fixture(variants);const d=await f.ops.createDraft(f.input());f.payment(d._id,patch);await denied(f.ops.attachPayment(d._id,d.localEffects.setupToken,ID.payment),'BOOKING_RECONCILIATION_REQUIRED');assert.equal(f.booking(d._id).paymentTransactionId,undefined);}});
check('invalid INR values are refused before effects',async variants=>{const f=fixture(variants);for(const value of [-1,NaN,Infinity,1.001,Number.MAX_SAFE_INTEGER,'1'])assert.throws(()=>f.money(value),error=>error.code==='BOOKING_RECONCILIATION_REQUIRED');assert.equal(f.money(0),0);assert.equal(f.money(1.01),101);});
check('reschedule moves owned hold atomically and cancellation releases new slot',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();f.state.tables.Slot.push({...clone(f.state.tables.Slot[0]),_id:ID.nextSlot,startTime:'11:00 AM',currentBookings:0,isAvailable:true});await f.ops.reschedule(draft._id,actor,{slotId:ID.nextSlot,bookingDate:'20261120',bookingTime:'11:00 AM'});assert.equal(f.state.tables.Slot[0].currentBookings,0);assert.equal(f.state.tables.Slot[1].currentBookings,1);await f.ops.cancel(draft._id,actor,'cancel',windowNoop);assert.equal(f.state.tables.Slot[1].currentBookings,0);});
check('reschedule failure leaves original reservation and schedule',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();f.state.tables.Slot.push({...clone(f.state.tables.Slot[0]),_id:ID.nextSlot,startTime:'11:00 AM',currentBookings:0,isAvailable:true});f.state.failFence=1;await assert.rejects(f.ops.reschedule(draft._id,actor,{slotId:ID.nextSlot,bookingDate:'20261120',bookingTime:'11:00 AM'}),/fence write failure/);assert.equal(f.state.tables.Slot[0].currentBookings,1);assert.equal(f.state.tables.Slot[1].currentBookings,0);assert.equal(f.booking(draft._id).slotId,ID.slot);});
check('follow-up hold acquisition and cancellation restore parent once',async variants=>{const f=fixture(variants);const parent=await f.ops.createDraft(f.input({_id:ID.parent,status:'completed',followUp:{benefitUsed:false}}),false);const d=await f.ops.createDraft(f.input({followUp:{isFollowUp:true,parentConsultationId:parent._id}}));assert.equal(f.booking(parent._id).followUp.benefitUsed,true);await f.ops.endSetup(d._id,d.localEffects.setupToken,false);await f.ops.cancel(d._id,actor,'cancel',windowNoop);await f.ops.cancel(d._id,actor,'again',windowNoop);assert.equal(f.booking(parent._id).followUp.benefitUsed,false);assert.equal(f.booking(parent._id).localEffects.followUpHeldByBookingId,null);});
check('whole BookingService initializes gateway and clears setup token',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());const result=await f.wholeBookingService().initializeBookingPayment(d,100,0,undefined,false);assert.equal(result.paymentRequired,true);assert.equal(result.booking.localEffects,undefined);assert.equal(f.booking(d._id).localEffects.setupToken,null);assert.equal(f.booking(d._id).localEffects.setupFailed,false);});
check('whole BookingService initializes wallet payment without leaking effects',async variants=>{const f=fixture(variants);const d=await f.ops.createDraft(f.input());const result=await f.wholeBookingService().initializeBookingPayment(d,100,0,undefined,true);assert.equal(result.paymentRequired,false);assert.equal(result.walletDeductedAmount,100);assert.equal(result.booking.localEffects,undefined);assert.equal(f.state.tables.Wallet[0].balance,900);assert.ok(f.effects.includes('sync-meet'));});
check('whole BookingService provider setup failure clears lease and keeps recoverable debit',async variants=>{const f=fixture(variants,{providerFailure:true});f.state.tables.Wallet[0].balance=50;const d=await f.ops.createDraft(f.input());await assert.rejects(f.wholeBookingService().initializeBookingPayment(d,100,0,undefined,true),/payment setup failure/);assert.equal(f.booking(d._id).localEffects.setupToken,null);assert.equal(f.booking(d._id).localEffects.setupFailed,true);assert.equal(f.state.tables.Wallet[0].balance,0);await f.ops.cancel(d._id,actor,'cancel',windowNoop);assert.equal(f.state.tables.Wallet[0].balance,50);});
check('whole BookingService cancellation retries postcommit cleanup while refund stays once',async variants=>{const f=fixture(variants,{cleanupFailure:true});const{draft}=await f.prepared();f.state.tables.Payment[0].status='paid';await f.ops.confirmPayment(ID.payment);const service=f.wholeBookingService();const result=await service.cancelBooking(draft._id,{cancellationReason:'cancel'},{_id:'aaaaaaaaaaaaaaaaaaaaaaaa',userType:'admin'});assert.equal(result.paymentStatus,'refunded');assert.equal(result.localEffects,undefined);await service.cancelBooking(draft._id,{},actor);assert.equal(f.state.tables.Wallet[0].balance,1100);assert.equal(f.effects.filter(effect=>effect==='clear').length,2);assert.equal(f.effects.filter(effect=>effect==='cancel-meet').length,2);});
check('whole PaymentService confirmation preserves cancellation and public response',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();await f.ops.cancel(draft._id,actor,'cancel',windowNoop);f.state.tables.Payment[0].status='paid';const result=await f.wholePaymentService().processBookingPayment(clone(f.state.tables.Payment[0]));assert.equal(result.entity.status,'cancelled');assert.equal(result.entity.localEffects,undefined);assert.equal(result.paymentRecord.status,'refunded');assert.ok(!f.effects.includes('schedule'));});
check('missing slot is refused for ordinary drafts',async variants=>{const f=fixture(variants);await denied(f.ops.createDraft(f.input({slotId:undefined})),'BOOKING_RECONCILIATION_REQUIRED');assert.equal(f.state.tables.Booking.length,0);});
check('same-slot reschedule cannot falsify appointment time',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();await denied(f.ops.reschedule(draft._id,actor,{slotId:ID.slot,bookingDate:'20261120',bookingTime:'11:00 AM'}),'BOOKING_RECONCILIATION_REQUIRED');assert.equal(f.booking(draft._id).bookingTime,'10:00 AM');});
check('generic update and delete cannot bypass financial command or retention',async variants=>{const f=fixture(variants);const{draft}=await f.prepared();const service=f.wholeBookingService();for(const patch of [{status:'cancelled'},{paymentStatus:'refunded'},{followUp:{benefitUsed:false}},{slotId:ID.nextSlot}])await denied(service.update(draft._id,patch,ID.user),'DEDICATED_BOOKING_COMMAND_REQUIRED');await denied(service.delete(draft._id,ID.user),'BOOKING_RETENTION_REQUIRED');assert.equal(f.booking(draft._id).status,'pending');});
check('zero-price failed setup remains pending and retry can complete',async variants=>{const f=fixture(variants,{providerFailure:true,basePrice:0});const service=f.wholeBookingService();await assert.rejects(service.createWellnessPackageBooking(f.input({price:0})),/payment setup failure/);assert.equal(f.state.tables.Booking.length,1);const row=f.state.tables.Booking[0];assert.equal(row.paymentStatus,'pending');assert.equal(row.localEffects.setupFailed,true);assert.equal(row.localEffects.setupToken,null);f.options.providerFailure=false;const result=await service.retryBookingPayment(row._id,actor);assert.equal(result.paymentRequired,false);assert.equal(result.booking.paymentStatus,'paid');});
check('whole service rounds server coupon fraction once into valid paise',async variants=>{const f=fixture(variants,{basePrice:99.99,couponDiscount:12.49875});const result=await f.wholeBookingService().createWellnessPackageBooking({...f.input(),couponCode:'SAVE'});assert.equal(result.booking.price,87.49);assert.equal(result.payment.amount,87.49);assert.equal(result.payment.discountAmount,12.5);assert.equal(f.state.tables.Payment[0].baseAmount,99.99);});
check('cutoff parses IST independently of host timezone and rejects trailing text',async variants=>{const f=fixture(variants);const policy=f.cancellationPolicy;assert.equal(policy.parseAppointment({bookingDate:'20261117',bookingTime:'10:00 AM'}).at.getTime(),Date.UTC(2026,10,17,4,30));for(const appointment of [{bookingDate:'20260230',bookingTime:'10:00 AM'},{bookingDate:'20261117',bookingTime:'10:00 AM trailing'},{bookingDate:'20261117',bookingTime:'25:00'}])assert.equal(policy.parseAppointment(appointment),null);});
for(const[date,hours]of [['20261117',24],['20261116',48]])check('paid '+hours+'h cutoff inclusive boundary '+date,async variants=>{const f=fixture(variants);const appointment={bookingDate:date,bookingTime:'10:00 AM'};const at=f.cancellationPolicy.parseAppointment(appointment).at.getTime();f.cancellationPolicy.enforceUserCancellationWindow([appointment],'user',new Date(at-hours*3600000-1));assert.throws(()=>f.cancellationPolicy.enforceUserCancellationWindow([appointment],'user',new Date(at-hours*3600000)),error=>error.code==='CANCELLATION_WINDOW_CLOSED');f.cancellationPolicy.enforceUserCancellationWindow([appointment],'admin',new Date(at-1));assert.throws(()=>f.cancellationPolicy.enforceUserCancellationWindow([appointment],'admin',new Date(at)),error=>error.code==='BOOKING_ALREADY_STARTED');});
async function suite(variants){const passed=[],failed=[];for(const entry of checks){try{await entry.body(variants);passed.push(entry.name);}catch(error){failed.push({name:entry.name,error:String(error)});}}return{passed,failed};}
const nominal=await suite(sources);assert.deepEqual(nominal.failed,[],JSON.stringify(nominal.failed));
const controls=[];
const mutants=[
  ['remove refund ledger atomic effect',[ ["await WalletTransactionModel.create([{ userId: booking.userId, walletId: String(wallet._id), transactionType: 'refund', amount: amount / 100,", "await Promise.resolve([{ userId: booking.userId, walletId: String(wallet._id), transactionType: 'refund', amount: amount / 100,"] ]],
  ['remove signed-owner selection fence',[[": { userId: { $eq: actor._id } }),",": {}),"]]],
  ['omit explicit hidden local-effects state selection',[[".select('+localEffects')",'']]],
  ['retain cancelled slot and remove duplicate-release fence',[["if (!effects.cancelled) {","if (true) {"],["'localEffects.heldSlotId': null, 'localEffects.followUpParentId': null,","'localEffects.heldSlotId': effects.heldSlotId, 'localEffects.followUpParentId': null,"]]],
];
for(const[name,changes]of mutants){let text=sources.local;for(const[before,after]of changes){assert.ok(text.includes(before),'exact weakening site '+name);text=text.replaceAll(before,after);}const result=await suite({...sources,local:text});assert.ok(result.failed.length,'weakening detected: '+name);controls.push({name,detectedBy:result.failed.map(item=>item.name)});}
const restored=await suite(sources);assert.deepEqual(restored.failed,[]);
console.log(JSON.stringify({status:'PASS',nominalCases:nominal.passed.length,restoredCases:restored.passed.length,cases:nominal.passed,controls,
 limits:['Whole local-effects helper, lifecycle and relevant whole BookingService/PaymentService methods under fixed stripped-import recording ports','Model/session adapter enforces select:false localEffects, same owned session, snapshot rollback and simulated callback retry','Schedules are serial recording scenarios, not native MongoDB concurrency/isolation/capacity evidence','ExternalBookingLocalOperations and WalletLocalOperations are blocked constructor ports; no external-booking or recharge methods/effects are evaluated',
 'No real Mongoose/Joi/HTTP/database/index/provider/SDK/config/client/session/production acceptance']},null,2));

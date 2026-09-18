import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
const scratch=path.resolve('work/forecast-tests');fs.mkdirSync(scratch,{recursive:true});
for(const [src,dest] of [['app/finance-dates.ts','dates'],['app/v3-engine.ts','budget'],['app/forecast-engine.ts','forecast'],['db/forecast.ts','history']]){
  let source=fs.readFileSync(src,'utf8').replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__forecastEnv;').replaceAll("'./finance-dates'","'./dates.mjs'").replaceAll("'./v3-engine'","'./budget.mjs'").replaceAll("'../app/v3-engine'","'./budget.mjs'");
  fs.writeFileSync(path.join(scratch,dest+'.mjs'),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
}
const {buildBudget,plusDays}=await import(pathToFileURL(path.join(scratch,'budget.mjs')));
const {buildForecast,forecastRange,cashAccounts}=await import(pathToFileURL(path.join(scratch,'forecast.mjs')));
const config={name:'Main',target:100000,period:'monthly',anchor:'2026-09-01',end:'2026-10-01',payday:25,allocation:'adaptive',carry:'none',carryCap:0,weights:[1,1,1,1,1,1,1],weekStart:1};
const bank={id:'bank',name:'Bank',type:'bank',currency:'EUR',balance_cents:200000,include_spendable:1,archived:0};
const savings={...bank,id:'savings',name:'Savings',type:'savings',balance_cents:50000,include_spendable:0};
const bucket={id:'food',name:'Groceries',kind:'protected',category_id:'food',target_cents:30000,released:0,priority:0,rollover:'none',rollover_cap:0,destination_id:null};
const tx=(id,amount,extra={})=>({id,date:'2026-09-10',amount_cents:amount,type:'expense',category_id:null,account_id:'bank',destination_account_id:null,counts_monthly:1,committed:0,recurring_plan_id:null,installment_plan_id:null,description:id,status:'posted',...extra});
const occurrence=(id,amount,extra={})=>({id,source_kind:'recurring',source_id:id,scheduled_date:'2026-09-25',due_date:'2026-09-25',title:id,type:'expense',amount_cents:amount,paid_cents:0,account_id:'bank',destination_account_id:null,category_id:null,committed:1,auto_post:0,status:'upcoming',transaction_id:null,...extra});
function input(extra={}){
 const data={today:'2026-09-18',currency:'EUR',accounts:[bank,savings],categories:[{id:'food',name:'Groceries'}],config,transactions:[],occurrences:[],templates:[],assignments:[],firstRecordedDate:'2026-08-01',historyFrom:'2025-09-18',...extra};
 data.current=buildBudget({today:data.today,start:'2026-09-01',end:'2026-10-01',config:data.config,funding:100000,accounts:data.accounts,transactions:data.transactions,occurrences:data.occurrences,buckets:data.templates,assignments:data.assignments,...extra.currentInput});
 return data;
}
const opts={from:'2026-09-18',to:'2026-09-30',accountIds:['bank'],estimateAccountId:'bank',buffer:0,lookback:28};
test('Calendar ranges include this month, next month, year end, leap-day and payday boundaries',()=>{
 assert.deepEqual(forecastRange(input(),'month',{}),{from:'2026-09-01',to:'2026-09-30'});
 assert.deepEqual(forecastRange(input({today:'2026-12-31'}),'nextMonth',{}),{from:'2027-01-01',to:'2027-01-31'});
 assert.deepEqual(forecastRange(input({today:'2028-02-29'}),'12months',{}),{from:'2028-02-29',to:'2029-02-27'});
 assert.equal(forecastRange(input(),'payday',{}),null);
 assert.equal(forecastRange(input({occurrences:[occurrence('salary',200000,{type:'income'})]}),'payday',{}).to,'2026-09-25');
 assert.equal(forecastRange(input({today:'2026-02-28',config:{...config,period:'payday',payday:31}}),'payday',{}).to,'2026-03-31');
});
test('Plan consumes remaining funded cash once including category overlap and optional scheduled bills',()=>{
 const data=input({transactions:[tx('food',10000,{category_id:'food'}),tx('coffee',5000)],templates:[bucket],occurrences:[occurrence('food subscription',8000,{category_id:'food',committed:0}),occurrence('rent',20000)]});
 const f=buildForecast(data,opts);
 assert.equal(f.summary.plan.closing,115000); // 200000 - (100000 funded - 15000 already posted)
 assert.equal(f.summary.scheduled.closing,172000);
 assert.equal(f.allocationDetails.find(x=>x.name==='Groceries').amount,-12000);
 assert.equal(f.allocationDetails.find(x=>x.name==='Everyday spending').amount,-45000);
});
test('Later windows simulate intervening periods, reset future targets and conserve cents in partial windows',()=>{
 const data=input({templates:[bucket],transactions:[tx('food',10000,{category_id:'food'})]});
 data.current.buckets[0].released=1;
 const full=buildForecast(data,{...opts,to:'2026-10-31'});
 const later=buildForecast(data,{...opts,from:'2026-10-01',to:'2026-10-31'});
 assert.equal(later.summary.plan.opening,full.rows.find(r=>r.date==='2026-09-30').plan);
 assert.equal(later.summary.plan.closing,full.summary.plan.closing);
 assert.equal(later.summary.plan.outgoing,100000);
 assert.equal(later.allocationDetails.find(x=>x.name==='Groceries').amount,-30000);
 const short=buildForecast(data,{...opts,to:'2026-09-20'});
 assert.deepEqual(short.rows.map(r=>r.plan),full.rows.slice(0,3).map(r=>r.plan));
});
test('Recorded balance reconstruction includes today, ignores corrected activity and excludes paid schedules',()=>{
 const data=input({transactions:[tx('yesterday',1000,{date:'2026-09-17'}),tx('today',2000,{date:'2026-09-18'}),tx('corrected',99999,{date:'2026-09-18',status:'corrected'})],occurrences:[occurrence('paid',10000,{status:'paid',paid_cents:10000})]});
 const f=buildForecast(data,{...opts,from:'2026-09-16'});
 assert.equal(f.rows[0].actual,203000);assert.equal(f.rows[1].actual,202000);assert.equal(f.rows[2].actual,200000);assert.equal(f.summary.scheduled.closing,200000);
});
test('Transfers and partial payments preserve account scope and overdue remainders occur once today',()=>{
 const data=input({occurrences:[occurrence('transfer',10000,{type:'saving',destination_account_id:'savings'}),occurrence('late',10000,{due_date:'2026-09-01',paid_cents:4000,status:'partial'})]});
 assert.equal(buildForecast(data,opts).summary.scheduled.closing,184000);
 assert.equal(buildForecast(data,{...opts,accountIds:['bank','savings']}).summary.scheduled.closing,244000);
 assert.equal(buildForecast(data,{...opts,accountIds:['savings']}).summary.scheduled.closing,60000);
 const f=buildForecast(data,opts);assert.equal(f.overdueCount,1);assert.equal(f.rows[0].events.find(e=>e.title==='late').amount,-6000);
});
test('Spending pace uses complete days and source accounts; linked payments are not counted twice',()=>{
 const transactions=[tx('spend',28000,{date:'2026-09-01'}),tx('excluded but real cash',2800,{date:'2026-09-02',counts_monthly:0}),tx('linked',70000,{date:'2026-09-03',recurring_plan_id:'rent'}),tx('today',20000,{date:'2026-09-18'}),tx('other account',14000,{date:'2026-09-05',account_id:'savings'})];
 const data=input({transactions,occurrences:[occurrence('rent',70000)]});
 const f=buildForecast(data,opts);assert.equal(f.sampleDays,28);assert.equal(f.sampleCount,2);assert.equal(f.summary.pace.closing,200000-70000-14300);
 const savingsForecast=buildForecast(data,{...opts,accountIds:['savings']});assert.equal(savingsForecast.summary.pace.closing,50000-6500);
 const short=buildForecast(data,{...opts,to:'2026-09-19'});assert.equal(short.rows[1].pace,f.rows[1].pace);
});
test('Sparse history falls back honestly and does not invent a zero-spend pace',()=>{
 const f=buildForecast(input({firstRecordedDate:'2026-09-16'}),opts);
 assert.equal(f.sampleDays,2);assert.equal(f.paceReady,false);assert.deepEqual(f.rows.map(r=>r.pace),f.rows.map(r=>r.plan));
});
test('Unlinked goals reserve money without cash movement; linked goals transfer within scope neutrally',()=>{
 const goal={...bucket,id:'goal',name:'Emergency fund',kind:'goal',category_id:null,target_cents:20000};
 let data=input({templates:[goal]});let f=buildForecast(data,opts);assert.equal(f.reservedWithoutMovement,20000);assert.equal(f.summary.plan.outgoing,80000);
 data=input({templates:[{...goal,destination_id:'savings'}]});f=buildForecast(data,{...opts,accountIds:['bank','savings']});assert.equal(f.summary.plan.outgoing,80000);
 assert.equal(buildForecast(data,opts).summary.plan.outgoing,100000);
 assert.equal(buildForecast(data,{...opts,accountIds:['savings']}).summary.plan.incoming,20000);
});
test('Purchase simulations honor dates and account scope without mutating source records',()=>{
 const data=input(),before=JSON.stringify(data),purchase={date:'2026-09-20',amount:12345,accountId:'bank'};
 const original=buildForecast(data,opts),whatif=buildForecast(data,{...opts,purchase});assert.equal(whatif.summary.plan.closing,original.summary.plan.closing-12345);assert.equal(whatif.summary.pace.closing,original.summary.pace.closing-12345);assert.equal(JSON.stringify(data),before);
 assert.equal(buildForecast(data,{...opts,purchase:{...purchase,date:'2026-09-01'}}).purchaseActive,false);
 assert.equal(buildForecast(data,{...opts,purchase:{...purchase,accountId:'savings'}}).purchaseActive,false);
});
test('Buffer risk includes opening cash before a same-day salary and detects the lowest future day',()=>{
 const data=input({accounts:[{...bank,balance_cents:1000}],occurrences:[occurrence('salary',200000,{type:'income',due_date:'2026-09-18'})]});
 const f=buildForecast(data,{...opts,buffer:2000});assert.equal(f.summary.scheduled.lowest.balance,1000);assert.equal(f.summary.scheduled.firstBelow,'2026-09-18');assert.equal(f.summary.scheduled.headroom,-1000);
 const zero=buildForecast(input({accounts:[{...bank,balance_cents:50000}]}),{...opts,buffer:10000});assert.ok(zero.summary.plan.belowDays>0);assert.equal(zero.summary.plan.lowest.balance,-50000);
});
test('Custom non-repeating budgets stop estimates, while scheduled payments can continue',()=>{
 const data=input({config:{...config,period:'custom',end:'2026-10-01'},occurrences:[occurrence('october rent',10000,{due_date:'2026-10-20'})]});
 const f=buildForecast(data,{...opts,from:'2026-10-01',to:'2026-10-31'});assert.equal(f.allocationDetails.length,0);assert.equal(f.summary.plan.outgoing,10000);
});
test('Invalid dates are rejected; multi-currency, credit and investments are never summed as cash',()=>{
 const data=input({accounts:[bank,{...bank,id:'dollar',currency:'USD'},{...bank,id:'portfolio',type:'investment'},{...bank,id:'card',type:'credit'},{...bank,id:'archived',archived:1}]});
 assert.deepEqual(cashAccounts(data).map(a=>a.id),['bank']);assert.equal(buildForecast(data,{...opts,accountIds:data.accounts.map(a=>a.id)}).currentCash,200000);
 for(const range of [{from:'2026-02-30'},{from:'2026-10-01',to:'2026-09-01'},{to:'2028-09-01'},{from:'2024-01-01'}])assert.throws(()=>buildForecast(data,{...opts,...range}));
});
test('History query isolates owners, returns older-than-current-month records and excludes corrected/future entries',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE transactions (id TEXT, user_id TEXT, date TEXT, status TEXT); CREATE TABLE v3_bucket_templates (id TEXT,user_id TEXT,archived INTEGER,priority INTEGER); CREATE TABLE v3_assignments (transaction_id TEXT,user_id TEXT,bucket_id TEXT,amount_cents INTEGER)');
 for(const row of [['a','alice','2026-08-01','posted'],['b','bob','2026-08-01','posted'],['c','alice','2026-07-01','corrected'],['d','alice','2027-01-01','posted']])db.prepare('INSERT INTO transactions VALUES(?,?,?,?)').run(...row);
 db.exec("INSERT INTO v3_bucket_templates VALUES('food','alice',0,0),('secret','bob',0,0),('old','alice',1,0); INSERT INTO v3_assignments VALUES('a','alice','food',100),('b','bob','secret',200)");
 globalThis.__forecastEnv={DB:{prepare:sql=>({bind:(...args)=>({all:async()=>({results:db.prepare(sql).all(...args)}),first:async()=>db.prepare(sql).get(...args)})})}};
 const {forecastHistory}=await import(pathToFileURL(path.join(scratch,'history.mjs')));
 const result=await forecastHistory('alice','2026-09-18');assert.deepEqual(result.transactions.map(t=>t.id),['a']);assert.deepEqual(result.templates.map(t=>t.id),['food']);assert.deepEqual(result.assignments.map(t=>t.transaction_id),['a']);assert.equal(result.firstRecordedDate,'2026-08-01');db.close();
});

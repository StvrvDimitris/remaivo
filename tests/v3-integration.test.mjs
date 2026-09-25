import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
const scratch=path.resolve('work/v3-tests');fs.mkdirSync(scratch,{recursive:true});
for(const [src,dest] of [['app/finance-dates.ts','dates'],['app/v3-engine.ts','engine'],['db/ensure.ts','ensure'],['db/v3.ts','server']]){
 let s=fs.readFileSync(src,'utf8').replace("import { env } from 'cloudflare:workers';",'const env=globalThis.__testEnv;').replace('import { env } from "cloudflare:workers";','const env=globalThis.__testEnv;').replaceAll("'../app/finance-dates'","'./dates.mjs'").replaceAll("'./finance-dates'","'./dates.mjs'").replaceAll("'../app/v3-engine'","'./engine.mjs'").replaceAll("'./ensure'","'./ensure.mjs'");
 fs.writeFileSync(path.join(scratch,dest+'.mjs'),ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
}
const sqlite=new DatabaseSync(':memory:');
class Statement{constructor(sql,args=[]){this.sql=sql;this.args=args;}bind(...args){return new Statement(this.sql,args);}async all(){return {results:sqlite.prepare(this.sql).all(...this.args)};}async first(){return sqlite.prepare(this.sql).get(...this.args)||null;}async run(){return {meta:{changes:sqlite.prepare(this.sql).run(...this.args).changes}};}}
const DB={prepare:sql=>new Statement(sql),batch:async stmts=>{sqlite.exec('BEGIN');try{const result=[];for(const s of stmts)result.push(/^\s*(SELECT|WITH|PRAGMA)\b/i.test(s.sql)?await s.all():await s.run());sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
globalThis.__testEnv={DB};
const engine=await import(pathToFileURL(path.join(scratch,'engine.mjs')));
const v3=await import(pathToFileURL(path.join(scratch,'server.mjs')));
for(const name of fs.readdirSync('drizzle').filter(n=>n.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+name,'utf8'));
const user='test-owner';
const config={name:'Test',target:100000,period:'monthly',anchor:'2026-09-01',end:'2026-10-01',payday:1,allocation:'adaptive',carry:'none',carryCap:0,weights:[1,1,1,1,1,1,1],weekStart:1};
const account={id:'cash',name:'Cash',type:'checking',currency:'EUR',archived:0,include_spendable:1,balance_cents:100000};
const tx=(id,amount,extra={})=>({id,date:'2026-09-17',amount_cents:amount,type:'expense',category_id:null,account_id:'cash',destination_account_id:null,counts_monthly:1,committed:0,recurring_plan_id:null,installment_plan_id:null,description:id,status:'posted',...extra});
const occurrence=(id,amount,extra={})=>({id,source_kind:'recurring',source_id:id,scheduled_date:'2026-09-20',due_date:'2026-09-20',title:id,type:'expense',amount_cents:amount,paid_cents:0,account_id:'cash',destination_account_id:null,category_id:null,committed:1,auto_post:0,status:'upcoming',transaction_id:null,...extra});
const bucket={id:'food',name:'Food',kind:'protected',category_id:'groceries',target_cents:20000,released:0,priority:0,rollover:'none',rollover_cap:0,destination_id:null};
const base={today:'2026-09-17',start:'2026-09-01',end:'2026-10-01',config,funding:100000,accounts:[account],transactions:[],buckets:[],occurrences:[],assignments:[]};

test('Cent allocation conserves the full amount, dates clamp at calendar boundaries',()=>{
 for(let total=0;total<10000;total+=37)assert.equal(engine.splitWeighted(total,[1,2,0.1,1.4,2.7,8,4]).reduce((s,n)=>s+n,0),total);
 assert.deepEqual(engine.periodFor({...config,period:'payday',payday:31},'2026-02-28'),{start:'2026-02-28',end:'2026-03-31'});
 assert.deepEqual(engine.periodFor({...config,period:'fortnightly',anchor:'2026-09-04'},'2026-09-17'),{start:'2026-09-04',end:'2026-09-18'});
});
test('Budget pace uses the active period, including today, across nonmonthly boundaries',()=>{
 const pace=engine.planPace({start:'2026-09-20',end:'2026-09-27',today:'2026-09-22',target:70000,spent:25000});
 assert.equal(pace.totalDays,7);
 assert.equal(pace.elapsedDays,3);
 assert.equal(pace.expectedSpent,30000);
 assert.equal(pace.paceDifference,-5000);
 assert.equal(pace.remaining,45000);
 assert.equal(pace.projected,58333);
 assert.equal(engine.planPace({start:'2026-09-20',end:'2026-09-27',today:'2026-09-19',target:70000,spent:0}).elapsedDays,0);
 assert.equal(engine.planPace({start:'2026-09-20',end:'2026-09-27',today:'2026-09-27',target:70000,spent:25000}).elapsedDays,7);
 assert.equal(engine.planPace({start:'2026-09-20',end:'2026-09-27',today:'2026-09-22',target:0,spent:25000}),null);
});
test('Plan-end trend gives recent variable spending more weight without moving the actual total',()=>{
 const common={start:'2026-09-01',end:'2026-10-01',today:'2026-09-18',target:110000,spent:25000,firstRecordedDate:'2026-08-01',occurrences:[],buckets:[]};
 const old=engine.planEndForecast({...common,transactions:[tx('old',2000,{date:'2026-08-22'})]});
 const recent=engine.planEndForecast({...common,transactions:[tx('recent',2000,{date:'2026-09-17'})]});
 const weekOld=engine.planEndForecast({...common,transactions:[tx('week-old',2000,{date:'2026-09-10'})]});
 assert.equal(old.sampleDays,28);assert.equal(recent.sampleDays,28);
 assert.equal(recent.futureDays,12);assert.ok(recent.variableDaily>old.variableDaily);
 assert.ok(Math.abs(recent.variableDaily-2*weekOld.variableDaily)<=1); // Seven days halves a day's contribution.
 assert.equal(recent.projected,common.spent+recent.variableRemaining);
 assert.equal(old.projected,common.spent+old.variableRemaining);
});
test('A one-off spike remains in actual spending but is capped in the projected daily habit',()=>{
 const gym=tx('gym',18000,{date:'2026-09-17'});
 const result=engine.planEndForecast({start:'2026-09-01',end:'2026-10-01',today:'2026-09-18',target:110000,spent:18000,firstRecordedDate:'2026-09-08',transactions:[gym],occurrences:[],buckets:[]});
 assert.equal(result.sampleDays,10);assert.equal(result.activeDays,1);assert.equal(result.spikeDays,1);
 assert.equal(result.confidence,'low');assert.ok(result.variableDaily>0);
 assert.ok(result.variableDaily<1800); // The €180 day is not projected as €18 per calendar day.
 assert.equal(result.projected,18000+result.variableRemaining);
});
test('The zero-MAD fallback preserves a recurring weekly shop while softening an isolated large day',()=>{
 const common={start:'2026-09-01',end:'2026-10-01',today:'2026-09-18',target:110000,firstRecordedDate:'2026-08-01',occurrences:[],buckets:[]};
 const shopDates=['2026-08-27','2026-09-03','2026-09-10','2026-09-17'];
 const groceries=engine.planEndForecast({...common,spent:60000,transactions:shopDates.map((date,i)=>tx(`shop-${i}`,15000,{date}))});
 assert.equal(groceries.sampleDays,28);assert.equal(groceries.activeDays,4);
 assert.equal(groceries.spikeDays,0);assert.ok(groceries.variableDaily>0);
 const mixed=engine.planEndForecast({...common,spent:26000,transactions:[...shopDates.map((date,i)=>tx(`small-${i}`,2000,{date})),tx('one-off gym',18000,{date:'2026-09-16'})]});
 assert.equal(mixed.spikeDays,1);assert.ok(mixed.variableDaily<groceries.variableDaily);
});
test('Released, active and overspent buckets add only unspent allowance while keeping every actual charge',()=>{
 const today='2026-09-18',start='2026-09-01',end='2026-10-01';
 const fuel={...bucket,id:'fuel',name:'Fuel',category_id:'fuel',target_cents:15800,released:1};
 const food={...bucket,id:'food',name:'Food',category_id:'food',target_cents:30000,released:0};
 const goal={...bucket,id:'goal',name:'Savings milestone',kind:'goal',category_id:null,destination_id:'savings',target_cents:10000,released:0};
 const over={...bucket,id:'over',name:'Already overspent',category_id:'other',target_cents:10000,released:0};
 const fuelTx=tx('fuel-charge',15800,{date:'2026-09-17',category_id:'fuel'});
 const foodTx=tx('food-shop',5000,{date:'2026-09-10',category_id:'food'});
 const everydayTx=tx('coffee',1000,{date:'2026-09-15'});
 const splitTx=tx('split',10000,{date:'2026-09-16'});
 const overTx=tx('above allowance',15000,{date:'2026-09-12',category_id:'other'});
 const foodPlan=occurrence('food-plan',5000,{category_id:'food',due_date:'2026-09-25'});
 const transactions=[fuelTx,foodTx,everydayTx,splitTx,overTx];
 const result=engine.buildBudget({...base,today,start,end,config:{...config,target:110000},funding:110000,transactions,buckets:[fuel,food,goal,over],occurrences:[foodPlan],assignments:[{transaction_id:'split',bucket_id:'food',amount_cents:6000}]});
 const forecast=engine.planEndForecast({start,end,today,target:110000,spent:result.totalSpent,firstRecordedDate:'2026-08-01',transactions:[...transactions,tx('older food',2500,{date:'2026-08-28',category_id:'food'})],occurrences:[foodPlan],buckets:result.buckets,allocationByTx:result.allocationByTx});
 assert.equal(result.totalSpent,46800);assert.equal(forecast.scheduledRemaining,5000);
 assert.equal(result.buckets.find(b=>b.id==='fuel').extra,0);
 assert.equal(result.buckets.find(b=>b.id==='food').extra,14000);
 assert.equal(result.buckets.find(b=>b.id==='goal').extra,10000);
 assert.equal(result.buckets.find(b=>b.id==='over').extra,0);
 assert.equal(result.buckets.find(b=>b.id==='over').deficit,5000);
 assert.equal(forecast.bucketExtra,24000);
 assert.equal(forecast.activeDays,2); // Coffee and the everyday portion of the split only.
 assert.equal(forecast.projected,46800+5000+24000+forecast.variableRemaining);
 const flexibleOnly=engine.planEndForecast({start,end,today,target:110000,spent:46800,firstRecordedDate:'2026-08-01',transactions:[everydayTx,tx('split everyday portion',4000,{date:'2026-09-16'})],occurrences:[foodPlan],buckets:result.buckets});
 assert.equal(forecast.variableDaily,flexibleOnly.variableDaily);
});
test('Plan-end trend counts only unpaid committed schedules, and linked payments only as actuals',()=>{
 const recurring=occurrence('rent',10000,{date:'2026-09-19',due_date:'2026-09-19',paid_cents:6000,status:'partial',transaction_id:'rent-paid'});
 const overdue=occurrence('overdue',2000,{due_date:'2026-08-29'});
 const result=engine.planEndForecast({start:'2026-09-14',end:'2026-09-21',today:'2026-09-18',target:70000,spent:14000,firstRecordedDate:'2026-09-01',transactions:[
  tx('rent-paid',6000,{date:'2026-09-17',recurring_plan_id:'rent'}),
  tx('ordinary',1000,{date:'2026-09-17'}),
  tx('committed',3000,{date:'2026-09-16',committed:1}),
  tx('today',4000,{date:'2026-09-18'})
 ],occurrences:[recurring,overdue,occurrence('optional',9999,{committed:0}),occurrence('income',9999,{type:'income'}),occurrence('transfer',9999,{type:'transfer'}),occurrence('paid',9999,{status:'paid'}),occurrence('later',9999,{due_date:'2026-09-22'})],buckets:[]});
 assert.equal(result.futureDays,2);assert.equal(result.activeDays,1);
 assert.equal(result.scheduledRemaining,6000);
 assert.equal(result.projected,14000+6000+result.variableRemaining);
});
test('Short history is marked insufficient and the plan forecast ends at the custom boundary',()=>{
 const common={start:'2026-09-17',end:'2026-09-20',target:30000,spent:5000,firstRecordedDate:'2026-09-17',transactions:[tx('today',5000,{date:'2026-09-18'})],occurrences:[occurrence('bill',2000,{due_date:'2026-09-19'})],buckets:[]};
 const sparse=engine.planEndForecast({...common,today:'2026-09-18'});
 assert.equal(sparse.sampleDays,1);assert.equal(sparse.confidence,'insufficient');assert.equal(sparse.projected,null);assert.equal(sparse.scheduledRemaining,2000);assert.equal(sparse.futureDays,1);
 const finalDay=engine.planEndForecast({...common,today:'2026-09-19'});
 assert.equal(finalDay.futureDays,0);assert.equal(finalDay.projected,7000);
 const ended=engine.planEndForecast({...common,today:'2026-09-20'});
 assert.equal(ended.futureDays,0);assert.equal(ended.scheduledRemaining,0);assert.equal(ended.projected,5000);
});
test('A €1,100 plan target stays separate from €1,081 of funded cash',()=>{
 const result=engine.buildBudget({...base,config:{...config,target:110000},funding:108100});
 assert.equal(result.target,110000);
 assert.equal(result.funding,108100);
 assert.equal(result.unfunded,1900);
 const pace=engine.planPace({start:result.start,end:result.end,today:base.today,target:result.target,spent:result.totalSpent});
 assert.equal(pace.remaining,110000);
 assert.equal(pace.expectedSpent,Math.round(110000*17/30));
});
test('Protected spending and commitments overlap once; released money, splits and deficits conserve money',()=>{
 let r=engine.buildBudget({...base,buckets:[bucket],transactions:[tx('food',5000,{category_id:'groceries'}),tx('fun',3000)],occurrences:[occurrence('foodplan',7000,{category_id:'groceries'}),occurrence('bill',10000)]});
 assert.equal(r.buckets[0].extra,8000);assert.equal(r.available,67000);assert.equal(r.totalSpent+r.protectedRemaining+r.available,r.funding);
 r=engine.buildBudget({...base,buckets:[{...bucket,released:1}],transactions:[tx('food',5000,{category_id:'groceries'})],occurrences:[occurrence('foodplan',7000,{category_id:'groceries'})]});assert.equal(r.available,88000);
 r=engine.buildBudget({...base,buckets:[bucket],transactions:[tx('mixed',25000)],assignments:[{transaction_id:'mixed',bucket_id:'food',amount_cents:15000}]});assert.equal(r.everydaySpent,10000);assert.equal(r.available,70000);
 r=engine.buildBudget({...base,buckets:[bucket],transactions:[tx('food',30000,{category_id:'groceries'}),tx('old',20000,{status:'corrected'}),tx('excluded',10000,{counts_monthly:0})]});assert.equal(r.buckets[0].deficit,10000);assert.equal(r.available,70000);
});
test('Daily and weekly guidance use one pool',()=>{
 for(const mode of ['adaptive','even','weighted'])for(const carry of ['none','positive','signed','capped']){const r=engine.buildBudget({...base,config:{...config,allocation:mode,carry,carryCap:10000},transactions:[tx('food',6000)]});assert.equal(r.available,94000);assert.equal(r.daily.spent,6000);assert.equal(r.weekly.spent,6000);}
});
test('Current Plan reconciliation preserves accounts and transaction history',async()=>{
 sqlite.prepare('INSERT INTO profiles(user_id,setup_complete) VALUES(?,1)').run(user);
 sqlite.prepare('INSERT INTO accounts(id,user_id,name,type,balance_cents) VALUES(?,?,?,?,?)').run('cash',user,'Cash','cash',98000);
 sqlite.prepare('INSERT INTO transactions(id,user_id,account_id,type,description,amount_cents,date) VALUES(?,?,?,?,?,?,?)').run('posted-expense',user,'cash','expense','Recorded purchase',2000,'2026-09-17');
 sqlite.prepare('INSERT INTO v3_versions(id,user_id,effective_from,config_json) VALUES(?,?,?,?)').run('initial:'+user,user,'1900-01-01',JSON.stringify(config));
 const before=JSON.stringify(sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=?').all(user));
 await v3.reconcileV3(user,base.today);
 await v3.reconcileV3(user,base.today);
 assert.equal(JSON.stringify(sqlite.prepare('SELECT id,balance_cents FROM accounts WHERE user_id=?').all(user)),before);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM transactions WHERE user_id=?').get(user).n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM v3_versions WHERE user_id=?').get(user).n,1);
 const snapshot=await v3.v3Snapshot(user,base.today);
 assert.equal(snapshot.result.totalSpent,2000);
 assert.equal(snapshot.result.funding,100000);
});
test('An existing period keeps its saved configuration even when newer or overlapping periods exist',async()=>{
 const owner='saved-period-owner';
 sqlite.prepare('INSERT INTO v3_versions(id,user_id,effective_from,config_json) VALUES(?,?,?,?)').run('saved-version',owner,'1900-01-01',JSON.stringify(config));
 sqlite.prepare('INSERT INTO v3_versions(id,user_id,effective_from,config_json) VALUES(?,?,?,?)').run('newer-version',owner,'2026-09-10',JSON.stringify({...config,target:200000}));
 sqlite.prepare('INSERT INTO v3_periods(id,user_id,start_date,end_date,version_id,funding_cents) VALUES(?,?,?,?,?,?)').run('saved-period',owner,'2026-09-01','2026-10-01','saved-version',100000);
 const original=await v3.currentPeriod(owner,'2026-09-17');
 assert.equal(original.period.id,'saved-period');
 assert.equal(original.config.target,100000);
 sqlite.prepare('INSERT INTO v3_periods(id,user_id,start_date,end_date,version_id,funding_cents) VALUES(?,?,?,?,?,?)').run('overlapping-period',owner,'2026-09-15','2026-09-30','newer-version',200000);
 const withOverlap=await v3.currentPeriod(owner,'2026-09-17');
 assert.equal(withOverlap.period.id,'saved-period');
 assert.equal(withOverlap.config.target,100000);
});
test('All preserved schedules expand and reconcile without duplicate balances or transactions',async()=>{
 await v3.reconcileV3(user,base.today);const before=JSON.stringify(sqlite.prepare('SELECT id,balance_cents FROM accounts ORDER BY id').all());const count=sqlite.prepare('SELECT COUNT(*) n FROM transactions').get().n;
 await v3.reconcileV3(user,base.today);assert.equal(JSON.stringify(sqlite.prepare('SELECT id,balance_cents FROM accounts ORDER BY id').all()),before);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM transactions').get().n,count);
 const snap=await v3.v3Snapshot(user,base.today);assert.equal(snap.result.totalSpent+snap.result.protectedRemaining+snap.result.available,snap.result.funding);assert.equal(snap.result.buckets.length,0);
});
test('Occurrence generation skips unchanged rows while preserving schedule state and applying plan edits',async()=>{
 const owner='occurrence-generator-owner';
 sqlite.prepare("INSERT INTO recurring_plans(id,user_id,title,type,amount_cents,account_id,frequency,interval_count,next_date,end_date,committed,auto_post) VALUES('generator-recurring',?,'Recurring expense','expense',10000,'cash','monthly',1,'2026-09-25','2026-09-25',1,0)").run(owner);
 sqlite.prepare("INSERT INTO installment_plans(id,user_id,title,total_cents,paid_cents,installment_count,first_due_date,payment_account_id) VALUES('generator-plan',?,'Installment expense',6000,0,1,'2026-09-25','cash')").run(owner);
 sqlite.prepare("INSERT INTO installment_payments(id,user_id,plan_id,sequence,due_date,amount_cents) VALUES('generator-payment',?,'generator-plan',1,'2026-09-25',6000)").run(owner);
 await v3.generateOccurrences(owner,base.today);
 sqlite.exec("CREATE TABLE occurrence_write_audit(id TEXT)");
 sqlite.exec("CREATE TRIGGER audit_occurrence_update AFTER UPDATE ON v3_occurrences WHEN NEW.user_id='occurrence-generator-owner' BEGIN INSERT INTO occurrence_write_audit(id) VALUES(NEW.id); END");
 const recurringId='recurring:generator-recurring:2026-09-25';const installmentId='installment:generator-payment';
 sqlite.prepare("UPDATE v3_occurrences SET due_date='2026-09-29',status='partial',paid_cents=1000 WHERE id=?").run(recurringId);
 sqlite.prepare("UPDATE v3_occurrences SET due_date='2026-09-30' WHERE id=?").run(installmentId);
 sqlite.exec('DELETE FROM occurrence_write_audit');
 await v3.generateOccurrences(owner,base.today);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM occurrence_write_audit').get().n,0);
 sqlite.prepare("UPDATE recurring_plans SET title='Updated recurring',amount_cents=20000,auto_post=1 WHERE id='generator-recurring'").run();
 sqlite.prepare("UPDATE installment_plans SET title='Updated installment',auto_post=1 WHERE id='generator-plan'").run();
 sqlite.prepare("UPDATE installment_payments SET amount_cents=8000 WHERE id='generator-payment'").run();
 await v3.generateOccurrences(owner,base.today);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM occurrence_write_audit').get().n,2);
 const recurring=sqlite.prepare('SELECT title,amount_cents,paid_cents,due_date,status,auto_post FROM v3_occurrences WHERE id=?').get(recurringId);
 assert.deepEqual({...recurring},{title:'Updated recurring',amount_cents:10000,paid_cents:1000,due_date:'2026-09-29',status:'partial',auto_post:1});
 const installment=sqlite.prepare('SELECT title,amount_cents,due_date,status,auto_post FROM v3_occurrences WHERE id=?').get(installmentId);
 assert.deepEqual({...installment},{title:'Updated installment',amount_cents:8000,due_date:'2026-09-30',status:'upcoming',auto_post:1});
 await v3.generateOccurrences(owner,base.today);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM occurrence_write_audit').get().n,2);
 sqlite.prepare("UPDATE recurring_plans SET active=0 WHERE id='generator-recurring'").run();
 sqlite.prepare("UPDATE installment_payments SET status='cancelled' WHERE id='generator-payment'").run();
 await v3.generateOccurrences(owner,base.today);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM occurrence_write_audit').get().n,4);
 assert.deepEqual(sqlite.prepare('SELECT status FROM v3_occurrences WHERE id IN (?,?) ORDER BY id').all(installmentId,recurringId).map(row=>row.status),['cancelled','cancelled']);
 await v3.generateOccurrences(owner,base.today);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM occurrence_write_audit').get().n,4);
});
test('Create, move, release and configure use cash limits and reject invalid dates',async()=>{
 await v3.v3Action(user,base.today,'v3Bucket',{name:'Test groceries',target:'100',kind:'protected',rollover:'positive'});
 let s=await v3.v3Snapshot(user,base.today);const b=s.result.buckets.find(b=>b.name==='Test groceries');assert.equal(b.extra,10000);
 await v3.v3Action(user,base.today,'v3Move',{from:b.id,to:'everyday',amount:'20'});s=await v3.v3Snapshot(user,base.today);assert.equal(s.result.buckets.find(x=>x.id===b.id).target_cents,8000);
 await v3.v3Action(user,base.today,'v3Release',{id:b.id});s=await v3.v3Snapshot(user,base.today);assert.equal(s.result.buckets.find(x=>x.id===b.id).extra,0);
 await assert.rejects(v3.v3Action(user,base.today,'v3Fund',{amount:'999999'}));
 await v3.v3Action(user,base.today,'v3Configure',{...config,target:'1000',carryCap:'0'});
 await assert.rejects(v3.v3Action(user,base.today,'v3Configure',{...config,target:'1000',anchor:'2026-02-30'}));
});
test('Partial installment records once, matches existing activity without moving cash twice, settles, reschedules',async()=>{
 const a=sqlite.prepare('SELECT * FROM accounts LIMIT 1').get();const pid='test-installment';
 sqlite.prepare("INSERT INTO installment_plans(id,user_id,title,total_cents,paid_cents,installment_count,frequency,first_due_date,payment_account_id) VALUES(?,?,?,10000,0,1,'monthly','2026-09-22',?)").run(pid,user,'Test purchase',a.id);
 sqlite.prepare("INSERT INTO installment_payments(id,user_id,plan_id,sequence,due_date,amount_cents) VALUES('test-payment',?,?,1,'2026-09-22',10000)").run(user,pid);
 await v3.generateOccurrences(user,base.today);
 await v3.v3Action(user,base.today,'v3Reschedule',{id:'installment:test-payment',date:'2026-09-25'});
 await v3.settleOccurrence(user,'installment:test-payment',base.today,3000);
 assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(a.id).balance_cents,a.balance_cents-3000);assert.equal(sqlite.prepare('SELECT paid_cents FROM installment_plans WHERE id=?').get(pid).paid_cents,3000);
 sqlite.prepare("INSERT INTO transactions(id,user_id,type,description,amount_cents,date,account_id) VALUES('match-tx',?,'installment_payment','Previously entered',7000,'2026-09-17',?)").run(user,a.id);sqlite.prepare('UPDATE accounts SET balance_cents=balance_cents-7000 WHERE id=?').run(a.id);
 await v3.settleOccurrence(user,'installment:test-payment',base.today,7000,'match-tx');
 assert.equal(sqlite.prepare('SELECT balance_cents FROM accounts WHERE id=?').get(a.id).balance_cents,a.balance_cents-10000);assert.equal(sqlite.prepare('SELECT paid_cents FROM installment_plans WHERE id=?').get(pid).paid_cents,10000);
 await assert.rejects(v3.settleOccurrence(user,'installment:test-payment',base.today));
 await v3.generateOccurrences(user,base.today);assert.equal(sqlite.prepare('SELECT status FROM v3_occurrences WHERE id=?').get('installment:test-payment').status,'paid');
});

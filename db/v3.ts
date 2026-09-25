import { env } from 'cloudflare:workers';
import { ensureFinanceSchema } from './ensure';
import { addCalendarInterval } from '../app/finance-dates';
import { buildBudget, consumesBudget, periodFor, plusDays, type BudgetConfig, type Bucket, type Occurrence, type MoneyAccount, type MoneyTransaction, type Assignment } from '../app/v3-engine';

const rows=async<T>(sql:string,...args:unknown[])=>(await env.DB.prepare(sql).bind(...args).all<T>()).results;
const cents=(value:unknown)=>{const n=Math.round(Number(value??0)*100);if(!Number.isSafeInteger(n)||n<0)throw new Error('Enter a valid nonnegative amount.');return n;};
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const id=()=>crypto.randomUUID();
const event=(user:string,kind:string,detail:string)=>env.DB.prepare('INSERT INTO v3_events (id,user_id,kind,detail) VALUES (?,?,?,?)').bind(id(),user,kind,detail);

export async function currentPeriod(user:string,today:string){
 const [versionRows,coveringPeriodRows]=await env.DB.batch([
   env.DB.prepare('SELECT * FROM v3_versions WHERE user_id=? AND effective_from<=? ORDER BY effective_from DESC,created_at DESC,rowid DESC LIMIT 1').bind(user,today),
   env.DB.prepare('SELECT * FROM v3_periods WHERE user_id=? AND start_date<=? AND end_date>? ORDER BY start_date DESC,end_date DESC LIMIT 1').bind(user,today,today),
 ]);
 const version=versionRows.results[0] as {id:string;config_json:string}|undefined;
 const coveringPeriod=coveringPeriodRows.results[0] as {id:string;start_date:string;end_date:string;version_id:string;funding_cents:number}|undefined;
 if(!version)throw new Error('Your plan is not ready yet. Refresh to continue.');
 const desired=JSON.parse(version.config_json) as BudgetConfig;const bounds=periodFor(desired,today);
 let period=coveringPeriod?.start_date===bounds.start&&coveringPeriod.end_date===bounds.end
   ? coveringPeriod
   : await env.DB.prepare('SELECT * FROM v3_periods WHERE user_id=? AND start_date=? AND end_date=?').bind(user,bounds.start,bounds.end).first<{id:string;start_date:string;end_date:string;version_id:string;funding_cents:number}>();
 if(!period){
   const accounts=await rows<MoneyAccount>('SELECT * FROM accounts WHERE user_id=? AND archived=0',user);
   const actuals=await rows<MoneyTransaction>("SELECT * FROM transactions WHERE user_id=? AND status='posted' AND date>=? AND date<? AND date<=?",user,bounds.start,bounds.end,today);
   const cash=accounts.filter(a=>a.include_spendable&&a.type!=='investment').reduce((a,b)=>a+b.balance_cents,0);
   const funding=Math.max(0,Math.min(desired.target,cash+actuals.filter(consumesBudget).reduce((a,b)=>a+b.amount_cents,0)));
   const periodId=id();const templates=await rows<Bucket>('SELECT * FROM v3_bucket_templates WHERE user_id=? AND archived=0 ORDER BY priority',user);
   const stmts=[env.DB.prepare('INSERT OR IGNORE INTO v3_periods(id,user_id,start_date,end_date,version_id,funding_cents) VALUES(?,?,?,?,?,?)').bind(periodId,user,bounds.start,bounds.end,version.id,funding)];
   for(const b of templates){let rollover=0;const previous=await env.DB.prepare('SELECT bp.*,p.start_date,p.end_date FROM v3_bucket_periods bp JOIN v3_periods p ON p.id=bp.period_id WHERE bp.user_id=? AND bp.bucket_id=? AND p.end_date<=? ORDER BY p.end_date DESC LIMIT 1').bind(user,b.id,bounds.start).first<Bucket&{start_date:string;end_date:string;period_id:string}>();
    if(previous&&b.rollover!=='none'&&!previous.released){
      const pastBuckets=await rows<Bucket>('SELECT bucket_id AS id,name,kind,category_id,target_cents,priority,rollover,rollover_cap,destination_id,released FROM v3_bucket_periods WHERE user_id=? AND period_id=?',user,previous.period_id);
      const pastTransactions=await rows<MoneyTransaction>("SELECT * FROM transactions WHERE user_id=? AND status='posted' AND date>=? AND date<?",user,previous.start_date,previous.end_date);
      const pastAssignments=await rows<Assignment>('SELECT * FROM v3_assignments WHERE user_id=?',user);
      const past=buildBudget({today:plusDays(previous.end_date,-1),start:previous.start_date,end:previous.end_date,config:desired,funding:0,accounts:[],transactions:pastTransactions,buckets:pastBuckets,occurrences:[],assignments:pastAssignments});
      const used=past.buckets.find(x=>x.id===b.id)?.spent||0;const left=previous.target_cents-used;
      rollover=b.rollover==='signed'?left:b.rollover==='capped'?Math.min(Math.max(0,left),b.rollover_cap):Math.max(0,left);
    }
    stmts.push(env.DB.prepare('INSERT OR IGNORE INTO v3_bucket_periods(id,user_id,period_id,bucket_id,name,kind,category_id,target_cents,priority,rollover,rollover_cap,destination_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM v3_periods WHERE id=?)').bind(periodId+':'+b.id,user,periodId,b.id,b.name,b.kind,b.category_id,Math.max(0,b.target_cents+rollover),b.priority,b.rollover,b.rollover_cap,b.destination_id,periodId));
   }await env.DB.batch(stmts);period=await env.DB.prepare('SELECT * FROM v3_periods WHERE user_id=? AND start_date=? AND end_date=?').bind(user,bounds.start,bounds.end).first();
 }
 if(!period)throw new Error('Could not open the budget period.');
 const saved=period.version_id===version.id ? version : await env.DB.prepare('SELECT config_json FROM v3_versions WHERE id=? AND user_id=?').bind(period.version_id,user).first<{config_json:string}>();return {period,config:JSON.parse(saved!.config_json) as BudgetConfig};
}

type PlanRow={id:string;title:string;type:string;amount_cents:number;next_date:string;frequency:string;interval_count:number;anchor_day:number;end_date:string|null;account_id:string|null;destination_account_id:string|null;category_id:string|null;committed:number;auto_post:number};
export async function generateOccurrences(user:string,today:string){
 type StoredOccurrence=Pick<Occurrence,'id'|'source_kind'|'source_id'|'title'|'amount_cents'|'paid_cents'|'account_id'|'destination_account_id'|'category_id'|'committed'|'auto_post'|'status'>;
 const [plans,existing,payments]=await Promise.all([
  rows<PlanRow>('SELECT * FROM recurring_plans WHERE user_id=? AND active=1',user),
  rows<StoredOccurrence>('SELECT id,source_kind,source_id,title,amount_cents,paid_cents,account_id,destination_account_id,category_id,committed,auto_post,status FROM v3_occurrences WHERE user_id=?',user),
  rows<{id:string;plan_id:string;due_date:string;amount_cents:number;title:string;payment_account_id:string;category_id:string;auto_post:number}>("SELECT ip.*,p.title,p.payment_account_id,p.category_id,p.auto_post FROM installment_payments ip JOIN installment_plans p ON p.id=ip.plan_id AND p.user_id=ip.user_id WHERE ip.user_id=? AND ip.status='upcoming' AND p.status='active'",user),
 ]);
 const byId=new Map(existing.map(o=>[o.id,o]));const horizon=plusDays(today,400);const stmts:D1PreparedStatement[]=[];
 for(const p of plans){let date=p.next_date;let n=0;while(date<horizon&&(!p.end_date||date<=p.end_date)){
   if(++n>2000)throw new Error('A schedule has too many missed occurrences. Move its next date forward to continue.');
   const oid='recurring:'+p.id+':'+date;const saved=byId.get(oid);
   if(!saved||saved.title!==p.title||(saved.paid_cents===0&&saved.amount_cents!==p.amount_cents)||saved.account_id!==p.account_id||saved.destination_account_id!==p.destination_account_id||saved.category_id!==p.category_id||saved.committed!==p.committed||saved.auto_post!==p.auto_post)
    stmts.push(env.DB.prepare(`INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,account_id,destination_account_id,category_id,committed,auto_post) VALUES(?,?,'recurring',?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,amount_cents=CASE WHEN v3_occurrences.paid_cents=0 THEN excluded.amount_cents ELSE v3_occurrences.amount_cents END,account_id=excluded.account_id,destination_account_id=excluded.destination_account_id,category_id=excluded.category_id,committed=excluded.committed,auto_post=excluded.auto_post`).bind(oid,user,p.id,date,date,p.title,p.type,p.amount_cents,p.account_id,p.destination_account_id,p.category_id,p.committed,p.auto_post));
   date=addCalendarInterval(date,p.frequency,p.interval_count,p.anchor_day);
 }}
 for(const p of payments){const oid='installment:'+p.id;const saved=byId.get(oid);
  if(!saved||saved.title!==p.title||saved.amount_cents!==p.amount_cents||saved.account_id!==p.payment_account_id||saved.category_id!==p.category_id||saved.auto_post!==p.auto_post)
   stmts.push(env.DB.prepare(`INSERT INTO v3_occurrences(id,user_id,source_kind,source_id,scheduled_date,due_date,title,type,amount_cents,account_id,category_id,committed,auto_post) VALUES(?,?,'installment',?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,amount_cents=excluded.amount_cents,account_id=excluded.account_id,category_id=excluded.category_id,auto_post=excluded.auto_post`).bind(oid,user,p.id,p.due_date,p.due_date,p.title,'installment_payment',p.amount_cents,p.payment_account_id,p.category_id,p.auto_post));
 }
 for(let i=0;i<stmts.length;i+=80)await env.DB.batch(stmts.slice(i,i+80));
 const activePlans=new Set(plans.map(p=>p.id));const activePayments=new Set(payments.map(p=>p.id));const cancellations:D1PreparedStatement[]=[];
 if(existing.some(o=>o.source_kind==='recurring'&&['upcoming','partial'].includes(o.status)&&!activePlans.has(o.source_id)))cancellations.push(env.DB.prepare("UPDATE v3_occurrences SET status='cancelled' WHERE user_id=? AND status IN ('upcoming','partial') AND source_kind='recurring' AND NOT EXISTS(SELECT 1 FROM recurring_plans p WHERE p.id=v3_occurrences.source_id AND p.active=1 AND p.user_id=?)").bind(user,user));
 if(existing.some(o=>o.source_kind==='installment'&&['upcoming','partial'].includes(o.status)&&!activePayments.has(o.source_id)))cancellations.push(env.DB.prepare("UPDATE v3_occurrences SET status='cancelled' WHERE user_id=? AND status IN ('upcoming','partial') AND source_kind='installment' AND NOT EXISTS(SELECT 1 FROM installment_payments p WHERE p.id=v3_occurrences.source_id AND p.status='upcoming' AND p.user_id=?)").bind(user,user));
 if(cancellations.length)await env.DB.batch(cancellations);
}

export async function settleOccurrence(user:string,oid:string,date:string,amountInput?:number,matchId?:string){
 const o=await env.DB.prepare("SELECT * FROM v3_occurrences WHERE id=? AND user_id=? AND status IN ('upcoming','partial')").bind(oid,user).first<Occurrence>();if(!o)throw new Error('This payment is already settled or no longer available.');
 const amount=amountInput??(o.amount_cents-o.paid_cents);if(amount<=0||amount>o.amount_cents-o.paid_cents)throw new Error('Enter an amount between zero and the unpaid balance.');
 if(['saving','investment'].includes(o.type)&&!o.destination_account_id)throw new Error('Choose a destination account in the plan before recording this transfer.');
 if(!o.account_id||!await env.DB.prepare('SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0').bind(o.account_id,user).first())throw new Error('Choose an active payment account first.');
 if(o.destination_account_id&&(o.destination_account_id===o.account_id||!await env.DB.prepare('SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0').bind(o.destination_account_id,user).first()))throw new Error('Choose a different active destination account.');
 const token=id();const txId=matchId||id();const newPaid=o.paid_cents+amount;const status=newPaid>=o.amount_cents?'paid':'partial';
 if(matchId){const tx=await env.DB.prepare("SELECT * FROM transactions WHERE id=? AND user_id=? AND status='posted'").bind(matchId,user).first<MoneyTransaction>();if(!tx||tx.type!==o.type||tx.account_id!==o.account_id||tx.amount_cents!==amount||tx.recurring_plan_id||tx.installment_plan_id||tx.destination_account_id!==o.destination_account_id)throw new Error('Choose an unlinked transaction of the same type, account and amount.');}
 const guard='EXISTS(SELECT 1 FROM v3_occurrences WHERE id=? AND user_id=? AND settlement_token=?)';
 const statements=[env.DB.prepare("UPDATE v3_occurrences SET paid_cents=?,status=?,transaction_id=?,settlement_token=? WHERE id=? AND user_id=? AND paid_cents=? AND status IN ('upcoming','partial')").bind(newPaid,status,txId,token,o.id,user,o.paid_cents)];
 const recurringId=o.source_kind==='recurring'?o.source_id:null;
 const payment=o.source_kind==='installment'?await env.DB.prepare('SELECT plan_id FROM installment_payments WHERE id=? AND user_id=?').bind(o.source_id,user).first<{plan_id:string}>():null;
 if(matchId)statements.push(env.DB.prepare(`UPDATE transactions SET recurring_plan_id=?,installment_plan_id=?,committed=? WHERE id=? AND user_id=? AND ${guard}`).bind(recurringId,payment?.plan_id||null,o.committed,txId,user,o.id,user,token));
 else {
 statements.push(env.DB.prepare(`INSERT INTO transactions(id,user_id,type,description,amount_cents,date,account_id,destination_account_id,category_id,committed,counts_monthly,recurring_plan_id,installment_plan_id) SELECT ?,?,?,?,?,?,?,?,?,?,1,?,? WHERE ${guard}`).bind(txId,user,o.type,o.title,amount,date,o.account_id,o.destination_account_id,o.category_id,o.committed,recurringId,payment?.plan_id||null,o.id,user,token));
 statements.push(env.DB.prepare(`UPDATE accounts SET balance_cents=balance_cents+? WHERE id=? AND user_id=? AND ${guard}`).bind(o.type==='income'?amount:-amount,o.account_id,user,o.id,user,token));
 if(['saving','investment'].includes(o.type))statements.push(env.DB.prepare(`UPDATE accounts SET balance_cents=balance_cents+? WHERE id=? AND user_id=? AND ${guard}`).bind(amount,o.destination_account_id,user,o.id,user,token));
 }
 if(payment){if(status==='paid')statements.push(env.DB.prepare(`UPDATE installment_payments SET status='paid' WHERE id=? AND user_id=? AND ${guard}`).bind(o.source_id,user,o.id,user,token));statements.push(env.DB.prepare(`UPDATE installment_plans SET paid_cents=paid_cents+?,status=CASE WHEN paid_cents+?>=total_cents THEN 'complete' ELSE status END WHERE id=? AND user_id=? AND ${guard}`).bind(amount,amount,payment.plan_id,user,o.id,user,token));}
 statements.push(env.DB.prepare(`INSERT INTO v3_payment_links(transaction_id,user_id,occurrence_id) SELECT ?,?,? WHERE ${guard}`).bind(txId,user,o.id,o.id,user,token));
 statements.push(event(user,'payment',`${o.title}: ${amount/100} recorded on ${date}${matchId?' by matching existing activity':''}.`));
 const results=await env.DB.batch(statements);if(!results[0].meta.changes)throw new Error('This payment changed. Refresh and try again.');
 if(status==='paid'&&o.source_kind==='recurring')await advancePlan(user,o.source_id);
}

async function advancePlan(user:string,planId:string){const plan=await env.DB.prepare('SELECT * FROM recurring_plans WHERE id=? AND user_id=?').bind(planId,user).first<PlanRow>();if(!plan)return;let date=plan.next_date;for(let i=0;i<2000;i++){const o=await env.DB.prepare('SELECT status FROM v3_occurrences WHERE user_id=? AND source_kind=? AND source_id=? AND scheduled_date=?').bind(user,'recurring',planId,date).first<{status:string}>();if(!o||!['paid','skipped'].includes(o.status))break;date=addCalendarInterval(date,plan.frequency,plan.interval_count,plan.anchor_day);}await env.DB.prepare('UPDATE recurring_plans SET next_date=?,active=CASE WHEN end_date IS NOT NULL AND end_date<? THEN 0 ELSE active END WHERE id=? AND user_id=?').bind(date,date,planId,user).run();}
export async function reconcileV3(user:string,today:string){
 await ensureFinanceSchema();
 await generateOccurrences(user,today);
 const [activeAccounts,due]=await Promise.all([
   rows<{id:string}>('SELECT id FROM accounts WHERE user_id=? AND archived=0',user),
   rows<Occurrence>("SELECT * FROM v3_occurrences WHERE user_id=? AND status IN ('upcoming','partial') AND auto_post=1 AND due_date<=? ORDER BY due_date,id",user,today),
 ]);
 const live=new Set(activeAccounts.map(a=>a.id));
 for(const o of due){if(!o.account_id||!live.has(o.account_id)||(['saving','investment'].includes(o.type)&&(!o.destination_account_id||!live.has(o.destination_account_id)||o.destination_account_id===o.account_id)))continue;await settleOccurrence(user,o.id,o.due_date);}
}

export async function v3Snapshot(user:string,today:string){
 const {period,config}=await currentPeriod(user,today);
 const [accountRows,transactionRows,trendRows,firstRecordedRows,bucketRows,occurrenceRows,assignmentRows,eventRows]=await env.DB.batch([
  env.DB.prepare('SELECT * FROM accounts WHERE user_id=?').bind(user),
  env.DB.prepare("SELECT * FROM transactions WHERE user_id=? AND status='posted' AND date>=? AND date<?").bind(user,period.start_date,period.end_date),
  env.DB.prepare("SELECT * FROM transactions WHERE user_id=? AND status='posted' AND date>=? AND date<? ORDER BY date,id").bind(user,plusDays(today,-28),today),
  env.DB.prepare("SELECT date FROM transactions WHERE user_id=? AND status='posted' AND date<=? ORDER BY date LIMIT 1").bind(user,today),
  env.DB.prepare('SELECT bucket_id AS id,name,kind,category_id,target_cents,priority,rollover,rollover_cap,destination_id,released FROM v3_bucket_periods WHERE user_id=? AND period_id=? ORDER BY priority,rowid').bind(user,period.id),
  env.DB.prepare("SELECT * FROM v3_occurrences WHERE user_id=? AND (due_date>=? OR status IN ('upcoming','partial')) ORDER BY due_date,id").bind(user,period.start_date),
  env.DB.prepare('SELECT * FROM v3_assignments WHERE user_id=?').bind(user),
  env.DB.prepare('SELECT id,kind,detail,created_at FROM v3_events WHERE user_id=? ORDER BY rowid DESC LIMIT 20').bind(user),
 ]);
 const accounts=accountRows.results as MoneyAccount[];
 const transactions=transactionRows.results as MoneyTransaction[];
 const trendTransactions=trendRows.results as MoneyTransaction[];
 const firstRecorded=firstRecordedRows.results[0] as {date:string}|undefined;
 const buckets=bucketRows.results as Bucket[];
 const occurrences=occurrenceRows.results as Occurrence[];
 const assignments=assignmentRows.results as Assignment[];
 const events=eventRows.results as {id:string;kind:string;detail:string;created_at:string}[];
 const result=buildBudget({today,start:period.start_date,end:period.end_date,config,funding:period.funding_cents,accounts,transactions,buckets,occurrences,assignments});
 return {periodId:period.id,config,result,occurrences,transactions,trendTransactions,firstRecordedDate:firstRecorded?.date??today,events};
}

export async function v3Action(user:string,today:string,action:string,p:Record<string,unknown>){
 await ensureFinanceSchema();await generateOccurrences(user,today);const {period,config}=await currentPeriod(user,today);
 if(action==='v3Configure'){
 const next={...config,...p,target:cents(p.target),carryCap:p.carryCap===undefined?config.carryCap:cents(p.carryCap),weekStart:Math.max(0,Math.min(6,Number(p.weekStart??config.weekStart))),payday:Math.max(1,Math.min(31,Number(p.payday)||1)),weights:Array.isArray(p.weights)?p.weights.map(x=>Math.max(0.1,Math.min(10,Number(x)||1))):config.weights} as BudgetConfig;
 if(!['monthly','weekly','fortnightly','payday','custom'].includes(next.period)||!['adaptive','even','weighted'].includes(next.allocation)||!['none','positive','signed','capped'].includes(next.carry))throw new Error('Choose a supported plan setting.');
 if(!validDate(next.anchor)||!validDate(next.end)||next.weights.length!==7)throw new Error('Enter valid dates and seven weekday weights.');
 const bounds=periodFor(next,today);if(bounds.end<=bounds.start||bounds.start>today||bounds.end<=today||daysApartSafe(bounds.start,bounds.end)>370)throw new Error('Choose a period containing today, no longer than one year.');
 const version=id();await env.DB.batch([env.DB.prepare('INSERT INTO v3_versions(id,user_id,effective_from,config_json) VALUES(?,?,?,?)').bind(version,user,today,JSON.stringify(next)),env.DB.prepare('UPDATE v3_periods SET version_id=? WHERE id=? AND user_id=? AND start_date=? AND end_date=?').bind(version,period.id,user,bounds.start,bounds.end),event(user,'configuration','Plan settings updated for the current period. Earlier periods retain their settings.')]);
 }else if(action==='v3Fund'){
 const state=await v3Snapshot(user,today);const amount=cents(p.amount);const max=Math.max(0,state.result.spendable+state.result.totalSpent);
 if(amount>max)throw new Error('Funding cannot exceed spending-account cash plus this period’s recorded spending.');
 await env.DB.batch([env.DB.prepare('UPDATE v3_periods SET funding_cents=? WHERE id=? AND user_id=?').bind(amount,period.id,user),event(user,'funding',`Period funding set to ${amount/100}. No account money was moved.`)]);
 }else if(action==='v3Bucket'){
 const name=String(p.name||'').trim();const target=cents(p.target);const kind=p.kind==='goal'?'goal':'protected';const bucketId=p.id?String(p.id):id();const cat=p.categoryId?String(p.categoryId):null;const destination=p.destinationId?String(p.destinationId):null;const rollover=['none','positive','signed','capped'].includes(String(p.rollover))?String(p.rollover):'none';
 if(!name||name.length>100)throw new Error('Give the bucket a name, up to 100 characters.');
 if(p.id&&!await env.DB.prepare('SELECT id FROM v3_bucket_templates WHERE id=? AND user_id=?').bind(bucketId,user).first())throw new Error('Bucket not found.');
 if(cat){if(!await env.DB.prepare("SELECT id FROM categories WHERE id=? AND user_id=? AND archived=0 AND kind='expense'").bind(cat,user).first())throw new Error('Choose an active expense category.');if(await env.DB.prepare('SELECT id FROM v3_bucket_templates WHERE user_id=? AND category_id=? AND archived=0 AND id!=?').bind(user,cat,bucketId).first())throw new Error('That category already belongs to another bucket.');}
 if(destination&&!await env.DB.prepare('SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0').bind(destination,user).first())throw new Error('Choose an active destination.');
 const priority=Number(p.priority)||0;const cap=cents(p.rolloverCap);
 await env.DB.batch([env.DB.prepare('INSERT INTO v3_bucket_templates(id,user_id,name,kind,category_id,target_cents,priority,rollover,rollover_cap,destination_id) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,category_id=excluded.category_id,target_cents=excluded.target_cents,priority=excluded.priority,rollover=excluded.rollover,rollover_cap=excluded.rollover_cap,destination_id=excluded.destination_id').bind(bucketId,user,name,kind,cat,target,priority,rollover,cap,destination),env.DB.prepare('INSERT INTO v3_bucket_periods(id,user_id,period_id,bucket_id,name,kind,category_id,target_cents,priority,rollover,rollover_cap,destination_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(period_id,bucket_id) DO UPDATE SET name=excluded.name,kind=excluded.kind,category_id=excluded.category_id,target_cents=excluded.target_cents,priority=excluded.priority,rollover=excluded.rollover,rollover_cap=excluded.rollover_cap,destination_id=excluded.destination_id').bind(period.id+':'+bucketId,user,period.id,bucketId,name,kind,cat,target,priority,rollover,cap,destination),event(user,'allocation',`${name} assigned ${target/100}. Matching activity and planned payments are covered inside this amount.`)]);
 }else if(action==='v3Release'||action==='v3Reopen'||action==='v3ArchiveBucket'){
 const bid=String(p.id);const stmts=[env.DB.prepare('UPDATE v3_bucket_periods SET released=? WHERE user_id=? AND period_id=? AND bucket_id=?').bind(action==='v3Reopen'?0:1,user,period.id,bid),event(user,'allocation',action==='v3Reopen'?'Bucket protection restored.':'Unused bucket protection released to everyday spending.')];if(action==='v3ArchiveBucket')stmts.push(env.DB.prepare('UPDATE v3_bucket_templates SET archived=1 WHERE id=? AND user_id=?').bind(bid,user));await env.DB.batch(stmts);
 }else if(action==='v3Move'){
 const amount=cents(p.amount);const from=String(p.from),to=String(p.to);if(!amount||from===to)throw new Error('Choose different buckets and a positive amount.');const state=await v3Snapshot(user,today);const source=state.result.buckets.find(b=>b.id===from);const dest=state.result.buckets.find(b=>b.id===to);if(from!=='everyday'&&!source||to!=='everyday'&&!dest)throw new Error('Bucket not found.');if(amount>(from==='everyday'?state.result.available:source!.extra))throw new Error('Only unused, unscheduled money can be reassigned.');
 const stmts:D1PreparedStatement[]=[];if(source)stmts.push(env.DB.prepare('UPDATE v3_bucket_periods SET target_cents=target_cents-? WHERE user_id=? AND period_id=? AND bucket_id=?').bind(amount,user,period.id,from));if(dest)stmts.push(env.DB.prepare('UPDATE v3_bucket_periods SET target_cents=target_cents+?,released=0 WHERE user_id=? AND period_id=? AND bucket_id=?').bind(amount,user,period.id,to));stmts.push(event(user,'allocation',`${amount/100} reassigned from ${source?.name||'Everyday'} to ${dest?.name||'Everyday'} for this period.`));await env.DB.batch(stmts);
 }else if(action==='v3Settle'){
 const date=String(p.date||today);if(!validDate(date)||date>today)throw new Error('Record a payment on today or an earlier actual payment date.');await settleOccurrence(user,String(p.id),date,p.amount===undefined?undefined:cents(p.amount),p.matchId?String(p.matchId):undefined);
 }else if(action==='v3Skip'||action==='v3Reschedule'){
 const o=await env.DB.prepare("SELECT * FROM v3_occurrences WHERE id=? AND user_id=? AND status IN ('upcoming','partial')").bind(p.id,user).first<Occurrence>();if(!o)throw new Error('Occurrence not available.');if(action==='v3Skip'){if(o.source_kind==='installment')throw new Error('Installment debt cannot be skipped. Reschedule the payment or edit the purchase.');if(o.paid_cents)throw new Error('A partially paid occurrence cannot be skipped.');await env.DB.prepare("UPDATE v3_occurrences SET status='skipped' WHERE id=? AND user_id=?").bind(o.id,user).run();await advancePlan(user,o.source_id);}else{const date=String(p.date);if(!validDate(date)||date<today)throw new Error('Choose today or a future due date.');await env.DB.prepare('UPDATE v3_occurrences SET due_date=? WHERE id=? AND user_id=?').bind(date,o.id,user).run();}await event(user,'schedule',`${o.title}: ${action==='v3Skip'?'occurrence skipped':'due date changed'}.`).run();
 }else if(action==='v3Assign'){
 const tx=await env.DB.prepare("SELECT * FROM transactions WHERE id=? AND user_id=? AND status='posted'").bind(p.transactionId,user).first<MoneyTransaction>();if(!tx||!consumesBudget(tx))throw new Error('Choose an included spending transaction.');const splits=Array.isArray(p.splits)?p.splits as {bucketId:string;amount:unknown}[]:[];const known=new Set((await rows<{bucket_id:string}>('SELECT bucket_id FROM v3_bucket_periods WHERE user_id=? AND period_id=?',user,period.id)).map(x=>x.bucket_id));if(splits.some(s=>!known.has(s.bucketId))||new Set(splits.map(s=>s.bucketId)).size!==splits.length)throw new Error('Choose each valid bucket once.');if(splits.reduce((s,a)=>s+cents(a.amount),0)>tx.amount_cents)throw new Error('Assigned amounts cannot exceed the transaction total.');await env.DB.batch([env.DB.prepare('DELETE FROM v3_assignments WHERE transaction_id=? AND user_id=?').bind(tx.id,user),...splits.map(s=>env.DB.prepare('INSERT INTO v3_assignments(id,user_id,transaction_id,bucket_id,amount_cents) VALUES(?,?,?,?,?)').bind(id(),user,tx.id,s.bucketId,cents(s.amount))),event(user,'assignment',`${tx.description}: funding assignments updated.`)]);
 }else throw new Error('Unknown planning action.');
}
function daysApartSafe(a:string,b:string){return Math.round((Date.parse(b)-Date.parse(a))/86400000);}

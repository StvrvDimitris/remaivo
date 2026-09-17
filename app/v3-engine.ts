import { addCalendarInterval } from './finance-dates';

export type MoneyAccount = { id: string; name: string; type: string; balance_cents: number; include_spendable: number; archived: number; currency: string };
export type MoneyTransaction = { id: string; date: string; amount_cents: number; type: string; category_id: string | null; account_id: string | null; destination_account_id: string | null; counts_monthly: number; committed: number; recurring_plan_id: string | null; installment_plan_id: string | null; description: string; status?: string };
export type BudgetConfig = { name: string; target: number; period: 'monthly'|'weekly'|'fortnightly'|'payday'|'custom'; anchor: string; end: string; payday: number; allocation: 'even'|'adaptive'|'weighted'; carry: 'none'|'positive'|'signed'|'capped'; carryCap: number; weights: number[]; weekStart: number };
export type Bucket = { id: string; name: string; kind: 'protected'|'goal'; category_id: string | null; target_cents: number; released: number; priority: number; rollover: string; rollover_cap: number; destination_id: string | null };
export type Occurrence = { id: string; source_kind: 'recurring'|'installment'; source_id: string; scheduled_date: string; due_date: string; title: string; type: string; amount_cents: number; paid_cents: number; account_id: string | null; destination_account_id: string | null; category_id: string | null; committed: number; auto_post: number; status: string; transaction_id: string | null };
export type Assignment = { transaction_id: string; bucket_id: string; amount_cents: number };
export const plusDays = (date: string, days: number) => new Date(new Date(date+'T12:00:00Z').valueOf()+days*86400000).toISOString().slice(0,10);
export const daysApart = (a: string,b: string) => Math.round((new Date(b+'T12:00:00Z').valueOf()-new Date(a+'T12:00:00Z').valueOf())/86400000);
export const weekBeginning = (date: string, first: number) => plusDays(date,-((new Date(date+'T12:00:00Z').getUTCDay()-first+7)%7));
export function periodFor(config: BudgetConfig, today: string) {
  if(config.period==='custom') return {start:config.anchor,end:config.end};
  if(config.period==='monthly') {const start=today.slice(0,7)+'-01';return {start,end:addCalendarInterval(start,'monthly',1,1)};}
  if(config.period==='payday') {
    const startMonth=today.slice(0,7)+'-01';
    const inMonth=(month:string)=>month.slice(0,7)+'-'+String(Math.min(config.payday,new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate())).padStart(2,'0');
    let start=inMonth(startMonth);if(start>today)start=inMonth(plusDays(startMonth,-1));
    return {start,end:addCalendarInterval(start,'monthly',1,config.payday)};
  }
  const length=config.period==='weekly'?7:14;
  const start=plusDays(config.anchor,Math.floor(daysApart(config.anchor,today)/length)*length);
  return {start,end:plusDays(start,length)};
}
export function splitWeighted(total:number, weights:number[]) {
  const safe=Math.max(0,Math.trunc(total));const sum=weights.reduce((a,b)=>a+Math.max(0,b),0);
  if(!sum)return weights.map(()=>0);
  const raw=weights.map(w=>safe*Math.max(0,w)/sum);const result=raw.map(Math.floor);
  const order=raw.map((n,i)=>({i,frac:n-result[i]})).sort((a,b)=>b.frac-a.frac||a.i-b.i);
  const remainder=safe-result.reduce((a,b)=>a+b,0);
  for(let i=0;i<remainder;i++)result[order[i].i]++;
  return result;
}
export function consumesBudget(tx:MoneyTransaction) {return (!tx.status||tx.status==='posted')&&tx.counts_monthly!==0&&['expense','installment_payment','saving','investment','fee'].includes(tx.type);}
export function carryAmount(amount:number,config:BudgetConfig){return config.carry==='signed'?amount:config.carry==='positive'?Math.max(0,amount):config.carry==='capped'?Math.min(Math.max(0,amount),config.carryCap):0;}
export type EngineInput = {today:string;start:string;end:string;config:BudgetConfig;funding:number;accounts:MoneyAccount[];transactions:MoneyTransaction[];buckets:Bucket[];occurrences:Occurrence[];assignments:Assignment[]};
export function buildBudget(input:EngineInput) {
  const {today,start,end,config,funding}=input;
  const counted=input.transactions.filter(t=>consumesBudget(t)&&t.date>=start&&t.date<end&&t.date<=today);
  const active=input.occurrences.filter(o=>['upcoming','partial'].includes(o.status)&&o.due_date<end&&o.type!=='income'&&o.committed===1);
  const transactionAmounts=new Map<string,number>(); const allocationByTx:Record<string,{bucket:string;amount:number}[]>={};
  const explicitByTx=new Map<string,Assignment[]>();for(const a of input.assignments)explicitByTx.set(a.transaction_id,[...(explicitByTx.get(a.transaction_id)||[]),a]);
  const sorted=[...input.buckets].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  const matched=(tx:MoneyTransaction)=>sorted.find(b=>b.category_id&&b.category_id===tx.category_id)||sorted.find(b=>b.kind==='goal'&&b.destination_id&&b.destination_id===tx.destination_account_id);
  let everydaySpent=0,commitmentSpent=0;
  for(const tx of counted){
    const splits=explicitByTx.get(tx.id);let used=0;
    if(splits?.length)for(const s of splits.filter(s=>sorted.some(b=>b.id===s.bucket_id))){const amount=Math.min(tx.amount_cents-used,Math.max(0,s.amount_cents));used+=amount;transactionAmounts.set(s.bucket_id,(transactionAmounts.get(s.bucket_id)||0)+amount);(allocationByTx[tx.id]??=[]).push({bucket:s.bucket_id,amount});}
    else {const bucket=matched(tx);if(bucket){used=tx.amount_cents;transactionAmounts.set(bucket.id,(transactionAmounts.get(bucket.id)||0)+used);allocationByTx[tx.id]=[{bucket:bucket.id,amount:used}];}}
    const remainder=tx.amount_cents-used;
    if(remainder>0){const kind=tx.installment_plan_id||tx.committed===1||['saving','investment'].includes(tx.type)?'commitments':'everyday';if(kind==='everyday')everydaySpent+=remainder;else commitmentSpent+=remainder;(allocationByTx[tx.id]??=[]).push({bucket:kind,amount:remainder});}
  }
  const plansByBucket=new Map<string,number>();let upcoming=0;
  const occurrenceBucket:Record<string,string>={};
  for(const o of active){const b=sorted.find(b=>b.category_id&&b.category_id===o.category_id)||sorted.find(b=>b.kind==='goal'&&b.destination_id&&b.destination_id===o.destination_account_id);const amount=Math.max(0,o.amount_cents-o.paid_cents);occurrenceBucket[o.id]=b?.id||'commitments';if(b)plansByBucket.set(b.id,(plansByBucket.get(b.id)||0)+amount);else upcoming+=amount;}
  const buckets=sorted.map(b=>{const spent=transactionAmounts.get(b.id)||0;const planned=plansByBucket.get(b.id)||0;const extra=b.released?0:Math.max(0,b.target_cents-spent-planned);return {...b,spent,planned,extra,remaining:planned+extra,deficit:Math.max(0,spent+planned-b.target_cents),burden:spent+planned+extra};});
  const protectedRemaining=upcoming+buckets.reduce((a,b)=>a+b.remaining,0);
  const totalSpent=counted.reduce((a,b)=>a+b.amount_cents,0);
  const everydayAllocation=funding-commitmentSpent-upcoming-buckets.reduce((a,b)=>a+b.burden,0);
  const available=everydayAllocation-everydaySpent;
  const actualRemaining=funding-totalSpent;
  const dates=Array.from({length:Math.max(0,Math.min(370,daysApart(start,end)))},(_,i)=>plusDays(start,i));
  const flexibleFor=(a:string,b:string)=>counted.filter(t=>t.date>=a&&t.date<b).reduce((sum,t)=>sum+(allocationByTx[t.id]||[]).filter(x=>x.bucket==='everyday').reduce((s,x)=>s+x.amount,0),0);
  const weights=dates.map(d=>config.allocation==='weighted'?config.weights[new Date(d+'T12:00:00Z').getUTCDay()]||1:1);
  const slices=splitWeighted(everydayAllocation,weights);
  const todayIndex=dates.indexOf(today);const weekStart=weekBeginning(today,config.weekStart);const ws=weekStart>start?weekStart:start;const we=plusDays(weekStart,7)<end?plusDays(weekStart,7):end;
  const spentToday=flexibleFor(today,plusDays(today,1));const spentWeek=flexibleFor(ws,plusDays(today,1));
  const guidance=(boundary:string,through:string,spent:number)=>{
    const before=flexibleFor(start,boundary);let base=0,carry=0;
    if(config.allocation==='adaptive') {const remainingDates=dates.filter(d=>d>=boundary);const projected=splitWeighted(everydayAllocation-before,remainingDates.map(()=>1));base=projected.filter((_,i)=>remainingDates[i]<through).reduce((a,b)=>a+b,0);}
    else{base=slices.filter((_,i)=>dates[i]>=boundary&&dates[i]<through).reduce((a,b)=>a+b,0);carry=carryAmount(slices.filter((_,i)=>dates[i]<boundary).reduce((a,b)=>a+b,0)-before,config);}
    return {base,carry,spent,remaining:base+carry-spent};
  };
  const daily=todayIndex>=0?guidance(today,plusDays(today,1),spentToday):{base:0,carry:0,spent:0,remaining:0};
  const weekly=todayIndex>=0?guidance(ws,we,spentWeek):{base:0,carry:0,spent:0,remaining:0};
  const spendable=input.accounts.filter(a=>!a.archived&&a.include_spendable&&a.type!=='investment').reduce((s,a)=>s+a.balance_cents,0);
  return {start,end,funding,target:config.target,unfunded:Math.max(0,config.target-funding),totalSpent,everydaySpent,commitmentSpent,upcoming,protectedRemaining,actualRemaining,everydayAllocation,available,buckets,daily,weekly,weekStart:ws,weekEnd:we,spendable,cashShortfall:Math.max(0,actualRemaining-spendable),allocationByTx,occurrenceBucket,dates,slices};
}
export function forecastCash(accounts:MoneyAccount[],occurrences:Occurrence[],today:string,days=45,scenario=0,scenarioDate=today) {
  const selected=new Set(accounts.filter(a=>a.archived!==1&&a.include_spendable===1&&a.type!=='investment').map(a=>a.id));
  let balance=accounts.filter(a=>selected.has(a.id)).reduce((a,b)=>a+b.balance_cents,0);const opening=balance;
  const rows=[];for(let i=0;i<days;i++){const date=plusDays(today,i);const items=occurrences.filter(o=>['upcoming','partial'].includes(o.status)&&(o.due_date===date||(i===0&&o.due_date<today)));let incoming=0,outgoing=0;
    for(const o of items){const amount=Math.max(0,o.amount_cents-o.paid_cents);if(o.type==='income'){if(selected.has(o.account_id||''))incoming+=amount;}else{if(selected.has(o.account_id||''))outgoing+=amount;if(['saving','investment','transfer'].includes(o.type)&&selected.has(o.destination_account_id||''))incoming+=amount;}}
    if(date===scenarioDate)outgoing+=Math.max(0,scenario);balance+=incoming-outgoing;rows.push({date,incoming,outgoing,balance});}
  return {opening,closing:balance,lowest:rows.reduce((a,b)=>b.balance<a.balance?b:a,rows[0]),rows};
}

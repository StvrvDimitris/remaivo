import { addCalendarInterval } from './finance-dates';

export type MoneyAccount = { id: string; name: string; type: string; balance_cents: number; include_spendable: number; archived: number; currency: string };
export type MoneyTransaction = { id: string; date: string; amount_cents: number; type: string; category_id: string | null; account_id: string | null; destination_account_id: string | null; counts_monthly: number; committed: number; recurring_plan_id: string | null; installment_plan_id: string | null; description: string; status?: string };
export type BudgetConfig = { name: string; target: number; period: 'monthly'|'weekly'|'fortnightly'|'payday'|'custom'; anchor: string; end: string; payday: number; allocation: 'even'|'adaptive'|'weighted'; carry: 'none'|'positive'|'signed'|'capped'; carryCap: number; weights: number[]; weekStart: number };
export type Bucket = { id: string; name: string; kind: 'protected'|'goal'; category_ids: string[]; target_cents: number; released: number; priority: number; rollover: string; rollover_cap: number; destination_id: string | null };
export type Occurrence = { id: string; source_kind: 'recurring'|'installment'; source_id: string; scheduled_date: string; due_date: string; title: string; type: string; amount_cents: number; counts_monthly?: number; paid_cents: number; account_id: string | null; destination_account_id: string | null; category_id: string | null; committed: number; auto_post: number; status: string; transaction_id: string | null };
export type Assignment = { transaction_id: string; bucket_id: string; amount_cents: number };
// Buckets store their matched categories as a JSON array of category IDs.
export function parseCategoryIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (typeof value !== 'string' || !value) return [];
  try { return parseCategoryIds(JSON.parse(value)); } catch { return []; }
}
export const coversCategory = (bucket: Pick<Bucket,'category_ids'>, categoryId: string | null) => Boolean(categoryId && bucket.category_ids.includes(categoryId));
export const plusDays = (date: string, days: number) => new Date(new Date(date+'T12:00:00Z').valueOf()+days*86400000).toISOString().slice(0,10);
export const daysApart = (a: string,b: string) => Math.round((new Date(b+'T12:00:00Z').valueOf()-new Date(a+'T12:00:00Z').valueOf())/86400000);
export function planPace(input:{start:string;end:string;today:string;target:number;spent:number}){
  const totalDays=daysApart(input.start,input.end);
  if(!Number.isFinite(totalDays)||totalDays<=0||!Number.isFinite(input.target)||input.target<=0||!Number.isFinite(input.spent)||input.spent<0)return null;
  const elapsedDays=Math.max(0,Math.min(totalDays,daysApart(input.start,plusDays(input.today,1))));
  const expectedSpent=Math.round(input.target*elapsedDays/totalDays);
  return {
    totalDays,elapsedDays,expectedSpent,
    remaining:input.target-input.spent,
    usedRatio:input.spent/input.target*100,
    elapsedRatio:elapsedDays/totalDays*100,
    paceDifference:input.spent-expectedSpent,
    projected:elapsedDays>0?Math.round(input.spent*totalDays/elapsedDays):null,
  };
}
export type PlanEndForecastInput = {
  start: string; end: string; today: string;
  target: number; spent: number;
  transactions: MoneyTransaction[]; occurrences: Occurrence[];
  buckets: (Pick<Bucket,'id'|'kind'|'category_ids'|'destination_id'|'released'> & {spent:number;planned:number;extra:number})[];
  allocationByTx?: Record<string,{bucket:string;amount:number}[]>;
  firstRecordedDate?: string;
};
export type PlanEndForecast = {
  projected: number | null;
  variableDaily: number | null;
  variableRemaining: number | null;
  scheduledRemaining: number;
  bucketExtra: number;
  futureDays: number;
  sampleDays: number;
  activeDays: number;
  spikeDays: number;
  confidence: 'insufficient' | 'low' | 'medium' | 'high';
};
const median = (values:number[]) => {
  const sorted=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
};
export function planEndForecast(input:PlanEndForecastInput):PlanEndForecast|null {
  const {start,end,today,target,spent}=input;
  const totalDays=daysApart(start,end);
  if(!Number.isFinite(totalDays)||totalDays<=0||!Number.isSafeInteger(target)||target<=0||!Number.isSafeInteger(spent)||spent<0)return null;
  const firstFuture=plusDays(today,1)>start?plusDays(today,1):start;
  const futureDays=Math.max(0,daysApart(firstFuture,end));
  // Open installments and recurring payments are represented by their unpaid
  // remainder. Their linked, already-posted installments are in `spent`.
  const scheduledRemaining=input.occurrences.filter(o=>
    today<end&&['upcoming','partial'].includes(o.status)&&o.committed===1&&o.counts_monthly!==0&&o.due_date<end&&
    ['expense','fee','installment_payment','saving','investment'].includes(o.type)
  ).reduce((sum,o)=>sum+Math.max(0,o.amount_cents-o.paid_cents),0);
  // `extra` is already net of bucket spending and scheduled payments in
  // buildBudget, so each remaining allowance is added only once.
  const bucketExtra=today<end?input.buckets.reduce((sum,b)=>sum+(b.released?0:Math.max(0,b.extra)),0):0;
  const earliest=input.firstRecordedDate||input.transactions.reduce((date,t)=>t.date<date?t.date:date,today);
  const historyStart=plusDays(today,-28)>earliest?plusDays(today,-28):earliest;
  const sampleDays=Math.max(0,Math.min(28,daysApart(historyStart,today)));
  const totals=Array.from({length:sampleDays},()=>0);
  for(const t of input.transactions){
    if(t.date<historyStart||t.date>=today||!consumesBudget(t)||
      !['expense','fee'].includes(t.type)||t.committed===1||
      t.recurring_plan_id||t.installment_plan_id)continue;
    const index=daysApart(historyStart,t.date);
    if(index>=0&&index<sampleDays){
      const allocations=input.allocationByTx?.[t.id];
      const matchesBucket=input.buckets.some(b=>
        coversCategory(b,t.category_id)||
        Boolean(b.kind==='goal'&&b.destination_id&&b.destination_id===t.destination_account_id)
      );
      // Use the exact current-period split when available. For older periods,
      // category/destination links identify spending governed by a bucket.
      const variable=allocations?allocations.filter(a=>a.bucket==='everyday').reduce((sum,a)=>sum+a.amount,0):matchesBucket?0:t.amount_cents;
      totals[index]+=Math.max(0,Math.min(t.amount_cents,variable));
    }
  }
  const activeDays=totals.filter(amount=>amount>0).length;
  if(!futureDays)return {projected:spent+scheduledRemaining+bucketExtra,variableDaily:0,variableRemaining:0,scheduledRemaining,bucketExtra,futureDays,sampleDays,activeDays,spikeDays:0,confidence:sampleDays>=14?'medium':'low'};
  if(sampleDays<7)return {projected:null,variableDaily:null,variableRemaining:null,scheduledRemaining,bucketExtra,futureDays,sampleDays,activeDays,spikeDays:0,confidence:'insufficient'};
  const middle=median(totals);
  const mad=median(totals.map(amount=>Math.abs(amount-middle)));
  const targetDaily=target/totalDays;
  // With many zero-spend days, both median and MAD can be zero. Use the
  // typical positive day when at least three spending days establish a pattern;
  // otherwise fall back to the plan's daily target. High days are capped,
  // never removed, and remain fully included in recorded spending.
  const positiveScale=activeDays>=3?2*median(totals.filter(amount=>amount>0)):0;
  const cap=mad>0?Math.max(middle+3*1.4826*mad,2*targetDaily):Math.max(2*middle,2*targetDaily,positiveScale);
  const spikeDays=totals.filter(amount=>amount>cap).length;
  let weighted=0,weightSum=0;
  totals.forEach((amount,index)=>{
    const daysAgo=sampleDays-1-index;
    const weight=Math.pow(0.5,daysAgo/7);
    weighted+=Math.min(amount,cap)*weight;
    weightSum+=weight;
  });
  const variableDaily=Math.round(weighted/weightSum);
  const variableRemaining=Math.round(weighted/weightSum*futureDays);
  const confidence=sampleDays>=21&&activeDays>=8?'high':sampleDays>=14&&activeDays>=4?'medium':'low';
  return {projected:spent+scheduledRemaining+bucketExtra+variableRemaining,variableDaily,variableRemaining,scheduledRemaining,bucketExtra,futureDays,sampleDays,activeDays,spikeDays,confidence};
}
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
  const active=input.occurrences.filter(o=>['upcoming','partial'].includes(o.status)&&o.due_date<end&&o.type!=='income'&&o.committed===1&&o.counts_monthly!==0);
  const transactionAmounts=new Map<string,number>(); const allocationByTx:Record<string,{bucket:string;amount:number}[]>={};
  const explicitByTx=new Map<string,Assignment[]>();for(const a of input.assignments)explicitByTx.set(a.transaction_id,[...(explicitByTx.get(a.transaction_id)||[]),a]);
  const sorted=[...input.buckets].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  const matched=(tx:MoneyTransaction)=>sorted.find(b=>coversCategory(b,tx.category_id))||sorted.find(b=>b.kind==='goal'&&b.destination_id&&b.destination_id===tx.destination_account_id);
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
  for(const o of active){const b=sorted.find(b=>coversCategory(b,o.category_id))||sorted.find(b=>b.kind==='goal'&&b.destination_id&&b.destination_id===o.destination_account_id);const amount=Math.max(0,o.amount_cents-o.paid_cents);occurrenceBucket[o.id]=b?.id||'commitments';if(b)plansByBucket.set(b.id,(plansByBucket.get(b.id)||0)+amount);else upcoming+=amount;}
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

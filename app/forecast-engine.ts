import { addCalendarInterval } from './finance-dates';
import { buildBudget, daysApart, periodFor, plusDays, splitWeighted, type Assignment, type Bucket, type BudgetConfig, type MoneyAccount, type MoneyTransaction, type Occurrence } from './v3-engine';

export type ForecastModel = 'plan' | 'pace' | 'scheduled';
export type ForecastPeriod = 'month' | 'remaining' | 'nextMonth' | 'payday' | 'budget' | 'nextBudget' | '30' | '90' | 'year' | '12months' | 'custom';
export type ForecastData = {
  today: string; currency: string; accounts: MoneyAccount[];
  categories: {id:string;name:string}[]; config: BudgetConfig;
  current: ReturnType<typeof buildBudget>; occurrences: Occurrence[];
  transactions: MoneyTransaction[]; templates: Bucket[]; assignments: Assignment[];
  firstRecordedDate: string; historyFrom: string;
  scenarios?: SavedForecastScenario[]; goals?: {id:string;name:string;target_cents:number|null;contributed_cents:number;account_id:string|null;color:string}[];
};
export type ScenarioEvent = {id:string;title:string;kind:'purchase'|'income'|'annual'|'goal'|'installment';amount_cents:number;date:string;account_id:string;installments:number;frequency:'once'|'monthly'|'yearly'};
export type SavedForecastScenario = {id:string;name:string;events:ScenarioEvent[];created_at:string;updated_at:string};
export type ForecastOptions = {
  from: string; to: string; accountIds: string[]; estimateAccountId: string;
  buffer: number; lookback: number;
  purchase?: { amount: number; date: string; accountId: string };
  scenarios?: SavedForecastScenario[];
};
export type ForecastEvent = { title: string; amount: number; kind: 'recorded'|'scheduled'|'estimate'|'purchase'|'scenario'; category: string; model?: 'plan'|'pace'; accountId?: string; overdue?: boolean; goalTransfer?: boolean; scenarioId?:string };
export type ForecastDay = { date: string; actual: number|null; plan: number; pace: number; scheduled: number; events: ForecastEvent[] };
const maxDate = (...dates: string[]) => dates.reduce((a,b)=>a>b?a:b);
const minDate = (...dates: string[]) => dates.reduce((a,b)=>a<b?a:b);
export const cashAccounts = (data: Pick<ForecastData,'accounts'|'currency'>) => data.accounts.filter(a=>!a.archived && !['investment','credit'].includes(a.type) && a.currency===data.currency);
export const validForecastDate = (s:string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
export function forecastRange(data: ForecastData, period: ForecastPeriod, custom: {from:string;to:string}) {
  const today=data.today, month=today.slice(0,7)+'-01', next=addCalendarInterval(month,'monthly',1,1);
  if(period==='month')return {from:month,to:plusDays(next,-1)};
  if(period==='remaining')return {from:today,to:plusDays(next,-1)};
  if(period==='nextMonth')return {from:next,to:plusDays(addCalendarInterval(next,'monthly',1,1),-1)};
  if(period==='budget')return {from:data.current.start,to:plusDays(data.current.end,-1)};
  if(period==='nextBudget'){
    if(data.config.period==='custom')return {from:data.current.end,to:data.current.end};
    const bounds=periodFor(data.config,data.current.end);return {from:bounds.start,to:plusDays(bounds.end,-1)};
  }
  if(period==='payday'){
    const nextIncome=data.occurrences.filter(o=>o.type==='income'&&['upcoming','partial'].includes(o.status)&&o.due_date>=today).sort((a,b)=>a.due_date.localeCompare(b.due_date))[0];
    const date=data.config.period==='payday'?periodFor(data.config,today).end:nextIncome?.due_date;
    return date?{from:today,to:date}:null;
  }
  if(period==='30'||period==='90')return {from:today,to:plusDays(today,Number(period)-1)};
  if(period==='year')return {from:today,to:today.slice(0,4)+'-12-31'};
  if(period==='12months')return {from:today,to:plusDays(addCalendarInterval(today,'yearly',1,Number(today.slice(8))),-1)};
  return custom;
}

// One movement function for recorded and scheduled items preserves internal transfers.
export function cashMovement(item: {type:string;account_id:string|null;destination_account_id:string|null}, amount: number, selected: Set<string>) {
  if(item.type==='installment_purchase')return 0;
  let net=selected.has(item.account_id||'')?(item.type==='income'?amount:-amount):0;
  if(['saving','investment','transfer'].includes(item.type)&&selected.has(item.destination_account_id||''))net+=amount;
  return net;
}
function scenarioDates(event:ScenarioEvent,to:string){
  const count=event.kind==='installment'?event.installments:event.frequency==='once'?1:12;
  const frequency=event.kind==='installment'?'monthly':event.frequency;
  const dates:string[]=[];let date=event.date;
  for(let i=0;i<count&&date<=to;i++){dates.push(date);date=frequency==='monthly'?addCalendarInterval(date,'monthly',1,Number(date.slice(8))):frequency==='yearly'?addCalendarInterval(date,'yearly',1,Number(date.slice(8))):plusDays(to,1);}
  return dates;
}
export function bestPurchaseDate(rows:ForecastDay[],model:ForecastModel,today:string,amount:number,buffer=0){
  const future=rows.filter(row=>row.date>=today);if(!future.length||amount<=0)return null;
  let suffix=Infinity,best:{date:string;lowest:number}|null=null;
  for(let i=future.length-1;i>=0;i--){suffix=Math.min(suffix,future[i][model]);const candidate={date:future[i].date,lowest:suffix-amount};if(!best||candidate.lowest>best.lowest)best=candidate;}
  return best&&{...best,headroom:best.lowest-buffer};
}

export function buildForecast(data: ForecastData, options: ForecastOptions) {
  const {today}=data, {from,to}=options;
  if(!validForecastDate(from)||!validForecastDate(to)||from>to||from<data.historyFrom||to>plusDays(today,365))throw new Error('Choose dates within the last year and the next 12 months, with the end on or after the start.');
  const eligible=cashAccounts(data), eligibleIds=new Set(eligible.map(a=>a.id));
  const selected=new Set(options.accountIds.filter(id=>eligibleIds.has(id)));
  const estimateAccount=eligibleIds.has(options.estimateAccountId)?options.estimateAccountId:'';
  const currentCash=eligible.filter(a=>selected.has(a.id)).reduce((sum,a)=>sum+a.balance_cents,0);
  const transactions=data.transactions.filter(t=>(!t.status||t.status==='posted')&&t.date<=today);
  const scheduled=data.occurrences.filter(o=>['upcoming','partial'].includes(o.status)&&o.amount_cents>o.paid_cents);
  const simulationStart=minDate(from,today);
  const rows:ForecastDay[]=Array.from({length:daysApart(simulationStart,maxDate(today,to))+1},(_,i)=>({date:plusDays(simulationStart,i),actual:null,plan:0,pace:0,scheduled:0,events:[]}));
  const byDate=new Map(rows.map(r=>[r.date,r]));
  const categoryNames=new Map(data.categories.map(c=>[c.id,c.name]));
  for(const tx of transactions){const amount=cashMovement(tx,tx.amount_cents,selected);if(amount)byDate.get(tx.date)?.events.push({title:tx.description||categoryNames.get(tx.category_id||'')||'Recorded movement',amount,kind:'recorded',category:categoryNames.get(tx.category_id||'')||'Other',accountId:tx.account_id||undefined});}
  for(const o of scheduled){const date=maxDate(today,o.due_date),amount=cashMovement(o,o.amount_cents-o.paid_cents,selected);if(amount)byDate.get(date)?.events.push({title:o.title,amount,kind:'scheduled',category:categoryNames.get(o.category_id||'')||'Other',accountId:o.account_id||undefined,overdue:o.due_date<today});}

  const allocationDetails:{name:string;from:string;to:string;amount:number;note:string}[]=[];
  let reservedWithoutMovement=0, futurePeriods=0, planDeficit=0;
  // Compute each complete budget period before clipping to the requested chart.
  // This prevents a short horizon from consuming an entire month's allowance.
  let cursor=today;
  for(let guard=0;cursor<=to&&guard<60;guard++){
    const isCurrent=cursor>=data.current.start&&cursor<data.current.end;
    if(data.config.period==='custom'&&!isCurrent)break;
    const bounds=isCurrent?{start:data.current.start,end:data.current.end}:periodFor(data.config,cursor);
    if(bounds.end<=cursor)break;
    const buckets=isCurrent?data.current.buckets:data.templates;
    const periodTransactions=isCurrent?transactions:[];
    // All scheduled budget costs consume their category allocation, including optional plans.
    const budgetOccurrences=scheduled.filter(o=>o.type!=='transfer'&&o.due_date<bounds.end&&(isCurrent||o.due_date>=bounds.start)).map(o=>({...o,committed:1}));
    const plan=buildBudget({today:isCurrent?today:bounds.start,start:bounds.start,end:bounds.end,config:data.config,funding:isCurrent?data.current.funding:data.config.target,accounts:data.accounts,transactions:periodTransactions,buckets,occurrences:budgetOccurrences,assignments:data.assignments});
    if(!isCurrent)futurePeriods++;
    planDeficit+=Math.max(0,-plan.available);
    const start=maxDate(today,bounds.start);
    const dates=Array.from({length:Math.max(0,Math.min(370,daysApart(start,bounds.end)))},(_,i)=>plusDays(start,i));
    const addAllocation=(name:string,total:number,destination:string|null=null)=>{
      const net=cashMovement({type:destination?'transfer':'expense',account_id:estimateAccount,destination_account_id:destination},total,selected);
      const slices=splitWeighted(Math.abs(net),dates.map(d=>data.config.allocation==='weighted'?data.config.weights[new Date(d+'T12:00:00Z').getUTCDay()]||1:1));
      let displayed=0;
      dates.forEach((date,i)=>{const amount=slices[i]*Math.sign(net);if(amount){byDate.get(date)?.events.push({title:name,amount,kind:'estimate',model:'plan',category:name,accountId:estimateAccount,goalTransfer:Boolean(destination)});if(date>=from&&date<=to)displayed+=amount;}});
      if(displayed)allocationDetails.push({name,from:start,to:plusDays(bounds.end,-1),amount:displayed,note:isCurrent?'Remaining funded allocation':'Repeating target'});
    };
    addAllocation('Everyday spending',Math.max(0,plan.available));
    for(const b of plan.buckets){
      if(b.kind==='goal'&&!b.destination_id){reservedWithoutMovement+=b.extra;continue;}
      addAllocation(b.name,b.extra,b.kind==='goal'?b.destination_id:null);
    }
    cursor=bounds.end;
  }

  const lookback=Math.min(90,Math.max(7,Math.trunc(options.lookback)||28));
  const historyStart=maxDate(plusDays(today,-lookback),data.firstRecordedDate,data.historyFrom);
  const sampleDays=Math.max(0,daysApart(historyStart,today));
  const paceReady=sampleDays>=7;
  // Exclude linked bills/repayments: the occurrence stream already models those.
  // Budget-excluded purchases still leave the bank and therefore remain in pace.
  const sample=transactions.filter(t=>t.date>=historyStart&&t.date<today&&['expense','fee'].includes(t.type)&&!t.recurring_plan_id&&!t.installment_plan_id);
  const groups=new Map<string,{total:number;accountId:string;category:string}>();
  for(const t of sample){if(!selected.has(t.account_id||''))continue;const category=categoryNames.get(t.category_id||'')||'Other spending';const key=JSON.stringify([t.account_id,category]);const g=groups.get(key)||{total:0,accountId:t.account_id!,category};g.total+=t.amount_cents;groups.set(key,g);}
  const futureDays=Math.max(0,daysApart(today,to)+1);
  if(paceReady){for(const g of groups.values()){
    // Cumulative rounding conserves cents and keeps prefixes identical across horizons.
    for(let i=0;i<futureDays;i++){const amount=Math.round(g.total*(i+1)/sampleDays)-Math.round(g.total*i/sampleDays);if(amount)byDate.get(plusDays(today,i))?.events.push({title:g.category,amount:-amount,kind:'estimate',model:'pace',category:g.category,accountId:g.accountId});}
  }}else for(const row of rows)for(const e of row.events.filter(e=>e.model==='plan'))row.events.push({...e,model:'pace'});
  // A goal transfer is a plan instruction rather than consumption inferred from shopping history.
  if(paceReady)for(const row of rows)for(const e of row.events.filter(e=>e.model==='plan'&&e.goalTransfer))row.events.push({...e,model:'pace'});
  for(const scenario of options.scenarios||[])for(const event of scenario.events)for(const [index,date] of scenarioDates(event,to).entries()){
    if(date<today)continue;
    const installmentAmount=event.kind==='installment'?Math.floor(event.amount_cents/event.installments)+(index<event.amount_cents%event.installments?1:0):event.amount_cents;
    const amount=cashMovement({type:event.kind==='income'?'income':event.kind==='goal'?'saving':'expense',account_id:event.account_id,destination_account_id:null},installmentAmount,selected);
    if(amount)byDate.get(date)?.events.push({title:`${scenario.name} · ${event.title}`,amount,kind:'scenario',category:event.kind==='annual'?'Annual expense':event.kind==='goal'?'Goal contribution':event.kind==='installment'?'Installment':'Scenario',accountId:event.account_id,scenarioId:scenario.id});
  }
  const purchase=options.purchase;
  const purchaseActive=Boolean(purchase&&Number.isSafeInteger(purchase.amount)&&purchase.amount>0&&validForecastDate(purchase.date)&&purchase.date>=today&&purchase.date<=to&&selected.has(purchase.accountId));
  if(purchaseActive&&purchase)byDate.get(purchase.date)?.events.push({title:'What-if purchase',amount:-purchase.amount,kind:'purchase',category:'What-if purchase',accountId:purchase.accountId});

  let actual=currentCash;
  for(let i=rows.length-1;i>=0;i--){const row=rows[i];if(row.date>today)continue;row.actual=actual;row.plan=row.pace=row.scheduled=actual;actual-=row.events.filter(e=>e.kind==='recorded').reduce((s,e)=>s+e.amount,0);}
  let plan=currentCash,pace=currentCash,baseline=currentCash;
  for(const row of rows){if(row.date<today)continue;const common=row.events.filter(e=>e.kind==='scheduled'||e.kind==='purchase'||e.kind==='scenario').reduce((s,e)=>s+e.amount,0);baseline+=common;plan+=common+row.events.filter(e=>e.model==='plan').reduce((s,e)=>s+e.amount,0);pace+=common+row.events.filter(e=>e.model==='pace').reduce((s,e)=>s+e.amount,0);row.plan=plan;row.pace=pace;row.scheduled=baseline;}
  const visible=rows.filter(r=>r.date>=from&&r.date<=to);
  const previous=byDate.get(plusDays(maxDate(from,today),-1));
  const opening=from<=today?currentCash:previous?.plan??currentCash;
  const summarize=(model:ForecastModel)=>{
    const future=visible.filter(r=>r.date>=today);
    const start=from<=today?currentCash:previous?.[model]??currentCash;
    const lowest=future.reduce((low,r)=>r[model]<low.balance?{date:r.date,balance:r[model]}:low,{date:maxDate(from,today),balance:start});
    const below=future.filter(r=>r[model]<options.buffer);
    const events=future.flatMap(r=>r.events.filter(e=>e.kind==='scheduled'||e.kind==='purchase'||e.kind==='scenario'||e.model===model));
    return {closing:visible.at(-1)?.[model]??currentCash,lowest,headroom:lowest.balance-options.buffer,belowDays:below.length,firstBelow:start<options.buffer?maxDate(from,today):below[0]?.date??null,incoming:events.filter(e=>e.amount>0).reduce((s,e)=>s+e.amount,0),outgoing:-events.filter(e=>e.amount<0).reduce((s,e)=>s+e.amount,0),opening:start,hasFuture:future.length>0};
  };
  const scenarioEvents=(options.scenarios||[]).flatMap(s=>s.events).length;
  return {rows:visible,currentCash,opening,summary:{plan:summarize('plan'),pace:summarize('pace'),scheduled:summarize('scheduled')},sampleDays,historyStart,paceReady,sampleCount:sample.filter(t=>selected.has(t.account_id||'')).length,allocationDetails,reservedWithoutMovement,futurePeriods,planDeficit,purchaseActive,scenarioEvents,overdueCount:scheduled.filter(o=>o.due_date<today&&cashMovement(o,o.amount_cents-o.paid_cents,selected)).length,hasIncome:scheduled.some(o=>o.type==='income'&&o.due_date<=to&&cashMovement(o,o.amount_cents-o.paid_cents,selected)>0)};
}

import { env } from 'cloudflare:workers';
import { plusDays } from '../app/v3-engine';

export type ScenarioKind = 'purchase'|'income'|'annual'|'goal'|'installment';
export type ScenarioEvent = { id:string; title:string; kind:ScenarioKind; amount_cents:number; date:string; account_id:string; installments:number; frequency:'once'|'monthly'|'yearly' };
export type SavedScenario = { id:string; name:string; events:ScenarioEvent[]; created_at:string; updated_at:string };
type ScenarioRow = {id:string;name:string;events_json:string;created_at:string;updated_at:string};
const date=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const label=(value:unknown,fallback:string)=>String(value||fallback).trim().replace(/\s+/g,' ').slice(0,80);
const parse=(value:string):ScenarioEvent[]=>{try{const events=JSON.parse(value);return Array.isArray(events)?events.filter(event=>event&&typeof event==='object').map((event,index)=>({id:typeof event.id==='string'?event.id:`event-${index}`,title:label(event.title,'Scenario item'),kind:['purchase','income','annual','goal','installment'].includes(event.kind)?event.kind:'purchase',amount_cents:Math.max(0,Math.trunc(Number(event.amount_cents)||0)),date:String(event.date||''),account_id:String(event.account_id||''),installments:Math.max(1,Math.min(60,Math.trunc(Number(event.installments)||1))),frequency:['once','monthly','yearly'].includes(event.frequency)?event.frequency:'once'})).filter(event=>date(event.date)&&event.amount_cents>0&&event.account_id):[]}catch{return [];}};
export async function listForecastScenarios(userId:string):Promise<SavedScenario[]>{
  const results=await env.DB.prepare('SELECT id,name,events_json,created_at,updated_at FROM forecast_scenarios WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT 20').bind(userId).all<ScenarioRow>();
  return results.results.map(row=>({id:row.id,name:row.name,events:parse(row.events_json),created_at:row.created_at,updated_at:row.updated_at})).filter(row=>row.events.length);
}
export async function saveForecastScenario(userId:string,today:string,payload:Record<string,unknown>){
  const name=label(payload.name,'Scenario');const raw=Array.isArray(payload.events)?payload.events:[];
  if(!name||!raw.length||raw.length>12)throw new Error('Give this scenario a name and add one to 12 future movements.');
  const events=raw.map((event,index)=>({id:crypto.randomUUID(),title:label((event as Record<string,unknown>).title,'Scenario item'),kind:(event as Record<string,unknown>).kind,amount_cents:Math.round(Number((event as Record<string,unknown>).amount)*100),date:(event as Record<string,unknown>).date,account_id:(event as Record<string,unknown>).accountId,installments:Math.trunc(Number((event as Record<string,unknown>).installments)||1),frequency:(event as Record<string,unknown>).frequency})).map((event,index)=>({id:event.id,title:event.title,kind:['purchase','income','annual','goal','installment'].includes(String(event.kind))?event.kind as ScenarioKind:'purchase',amount_cents:event.amount_cents,date:String(event.date||''),account_id:String(event.account_id||''),installments:Math.max(1,Math.min(60,event.installments)),frequency:['once','monthly','yearly'].includes(String(event.frequency))?event.frequency as ScenarioEvent['frequency']:'once'}));
  if(events.some(event=>!date(event.date)||event.date<today||event.date>plusDays(today,365)||!Number.isSafeInteger(event.amount_cents)||event.amount_cents<=0||!event.account_id))throw new Error('Each scenario item needs a positive amount, an active account, and a date within the next 12 months.');
  const accounts=await env.DB.batch(events.map(event=>env.DB.prepare('SELECT id FROM accounts WHERE id=? AND user_id=? AND archived=0').bind(event.account_id,userId)));
  if(accounts.some(result=>!result.results.length))throw new Error('One of the scenario accounts is no longer available.');
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO forecast_scenarios (id,user_id,name,events_json) VALUES (?,?,?,?)').bind(id,userId,name,JSON.stringify(events)).run();
  return id;
}
export async function removeForecastScenario(userId:string,id:string){
  const result=await env.DB.prepare('DELETE FROM forecast_scenarios WHERE id=? AND user_id=?').bind(id,userId).run();
  if(!result.meta.changes)throw new Error('That scenario is no longer available.');
}

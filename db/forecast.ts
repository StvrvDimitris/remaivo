import { env } from 'cloudflare:workers';
import { plusDays, type Assignment, type Bucket, type MoneyTransaction } from '../app/v3-engine';

// Only the signed-in user's history is read. Forecasts never write transactions.
export async function forecastHistory(userId: string, today: string) {
  const from = plusDays(today, -365);
  const history = await env.DB.prepare("SELECT * FROM transactions WHERE user_id=? AND status='posted' AND date>=? AND date<=? ORDER BY date,id").bind(userId, from, today).all<MoneyTransaction>();
  const templates = await env.DB.prepare('SELECT *, 0 AS released FROM v3_bucket_templates WHERE user_id=? AND archived=0 ORDER BY priority,id').bind(userId).all<Bucket>();
  const assignments = await env.DB.prepare('SELECT a.transaction_id,a.bucket_id,a.amount_cents FROM v3_assignments a JOIN transactions t ON t.id=a.transaction_id AND t.user_id=a.user_id WHERE a.user_id=? AND t.date<=?').bind(userId, today).all<Assignment>();
  const first = await env.DB.prepare("SELECT MIN(date) AS date FROM transactions WHERE user_id=? AND status='posted' AND date<=?").bind(userId, today).first<{date: string | null}>();
  return { transactions: history.results, templates: templates.results, assignments: assignments.results, firstRecordedDate: first?.date || today, historyFrom: from };
}

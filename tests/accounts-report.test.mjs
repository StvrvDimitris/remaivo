import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const scratch = path.resolve('work/accounts-report-tests');
fs.mkdirSync(scratch, { recursive: true });
const compile = (source, target) => fs.writeFileSync(path.join(scratch, target), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
compile(fs.readFileSync('app/investment-valuations.ts', 'utf8'), 'investment-valuations.mjs');
compile(fs.readFileSync('app/accounts-report.ts', 'utf8').replace('"./investment-valuations"', '"./investment-valuations.mjs"'), 'accounts-report.mjs');
const { buildAccountsReport, reportPeriod } = await import(pathToFileURL(path.join(scratch, 'accounts-report.mjs')));

test('Report periods cover whole months or years and mark the current one as partial', () => {
  assert.deepEqual(reportPeriod('2026-09', '2026-10-08'), { kind: 'month', key: '2026-09', from: '2026-09-01', to: '2026-09-30', partial: false });
  assert.deepEqual(reportPeriod('2026-02', '2026-10-08').to, '2026-02-28');
  assert.deepEqual(reportPeriod(null, '2026-10-08'), { kind: 'month', key: '2026-10', from: '2026-10-01', to: '2026-10-08', partial: true });
  assert.deepEqual(reportPeriod('2026', '2026-10-08'), { kind: 'year', key: '2026', from: '2026-01-01', to: '2026-10-08', partial: true });
  assert.deepEqual(reportPeriod('2025', '2026-10-08').to, '2025-12-31');
  assert.equal(reportPeriod('2026-12', '2026-10-08').key, '2026-10');
  assert.equal(reportPeriod('2026-13', '2026-10-08').key, '2026-10');
});

// Balances below are today's (8 Oct). September is reconstructed by removing October's entries.
const accounts = [
  { id: 'bank', name: 'Bank', type: 'bank', balance_cents: 120000, archived: 0, created_at: '2026-08-01 10:00:00' },
  { id: 'jar', name: 'Jar', type: 'savings', balance_cents: 10000, archived: 0, created_at: '2026-08-01 10:00:00' },
  { id: 'fund', name: 'Fund', type: 'investment', balance_cents: 20000, archived: 0, created_at: '2026-08-01 10:00:00' },
  { id: 'card', name: 'Card', type: 'credit', balance_cents: -10000, archived: 0, created_at: '2026-08-01 10:00:00' },
  { id: 'wallet', name: 'Wallet', type: 'cash', balance_cents: 5000, archived: 0, created_at: '2026-09-15 10:00:00' },
  { id: 'old', name: 'Old', type: 'bank', balance_cents: 0, archived: 1, created_at: '2026-01-01 10:00:00' },
  { id: 'later', name: 'Later', type: 'bank', balance_cents: 0, archived: 0, created_at: '2026-10-05 10:00:00' },
];
const tx = (id, type, amount, date, account_id, destination_account_id = null) => ({ id, type, amount_cents: amount, date, account_id, destination_account_id });
const transactions = [
  tx('salary', 'income', 200000, '2026-09-01', 'bank'),
  tx('rent', 'expense', 50000, '2026-09-03', 'bank'),
  tx('save', 'transfer', 30000, '2026-09-05', 'bank', 'jar'),
  tx('invest', 'investment', 20000, '2026-09-10', 'jar', 'fund'),
  tx('fix', 'balance_adjustment', 1000, '2026-09-12', null, 'bank'),
  tx('opened', 'opening_balance', 5000, '2026-09-15', null, 'wallet'),
  tx('shoes', 'expense', 10000, '2026-09-20', 'card'),
  tx('loan', 'installment_payment', 2000, '2026-09-25', 'bank'),
  tx('october', 'expense', 9000, '2026-10-02', 'bank'),
];

test('A month reconstructs start and end balances and explains the change in net worth', () => {
  const report = buildAccountsReport({ period: reportPeriod('2026-09', '2026-10-08'), accounts, transactions, snapshots: [], firstDate: '2026-08-01' });
  const row = id => report.groups.flatMap(group => group.accounts).find(account => account.id === id);
  // Bank ends September before October's 90 expense: 1200 + 90.
  assert.equal(row('bank').end, 129000);
  assert.equal(row('bank').start, 129000 - 200000 - 1000 + 50000 + 30000 + 2000);
  assert.deepEqual({ ...row('bank').in }, { income: 200000, spending: 0, transfers: 0, adjustments: 1000, opening: 0, total: 201000 });
  assert.deepEqual({ ...row('bank').out }, { income: 0, spending: 52000, transfers: 30000, adjustments: 0, opening: 0, total: 82000 });
  assert.deepEqual([row('jar').start, row('jar').end], [0, 10000]);
  assert.deepEqual([row('card').start, row('card').end], [0, -10000]);
  assert.deepEqual([row('wallet').start, row('wallet').end], [0, 5000]);
  assert.equal(row('old'), undefined);
  assert.equal(row('later'), undefined);
  assert.deepEqual({ ...report.bridge }, { income: 200000, spending: 62000, saved: 138000, adjustments: 1000, accountsAdded: 5000 });
  assert.equal(report.netWorth.change, report.bridge.saved + report.bridge.adjustments + report.bridge.accountsAdded);
  assert.equal(report.netWorth.end - report.netWorth.start, report.netWorth.change);
  assert.equal(report.rates.invested, 20000);
  assert.equal(report.rates.investedPercent, 10);
  assert.equal(report.rates.savedPercent, 69);
  assert.deepEqual(report.groupFlows.map(flow => ({ ...flow })), [{ from: 'cash', to: 'savings', amount: 30000 }, { from: 'savings', to: 'investments', amount: 20000 }]);
  assert.deepEqual(report.groups.map(group => group.id), ['cash', 'savings', 'investments', 'credit']);
});

test('Investment values use the latest snapshot on or before the period end, plus later money in', () => {
  const snapshots = [
    { id: 's1', account_id: 'fund', snapshot_date: '2026-09-08', value_cents: 500, note: null, created_at: '2026-09-08T00:00:00Z' },
    { id: 's2', account_id: 'fund', snapshot_date: '2026-10-07', value_cents: 99999, note: null, created_at: '2026-10-07T00:00:00Z' },
  ];
  const september = buildAccountsReport({ period: reportPeriod('2026-09', '2026-10-08'), accounts, transactions, snapshots, firstDate: '2026-08-01' });
  assert.deepEqual({ ...september.investments[0] }, { id: 'fund', name: 'Fund', start: 0, added: 20000, end: 20000, estimatedValue: 20500, snapshotDate: '2026-09-08' });
  const august = buildAccountsReport({ period: reportPeriod('2026-08', '2026-10-08'), accounts, transactions, snapshots, firstDate: '2026-08-01' });
  assert.equal(august.investments[0].estimatedValue, null);
});

test('A year adds up its months, and transfers inside a group never show as flows', () => {
  const year = buildAccountsReport({ period: reportPeriod('2026', '2026-10-08'), accounts, transactions: [...transactions, tx('move', 'transfer', 700, '2026-10-03', 'bank', 'wallet')], snapshots: [], firstDate: '2026-08-01' });
  assert.equal(year.period.partial, true);
  assert.equal(year.netWorth.end, 145000);
  assert.equal(year.netWorth.change, year.bridge.saved + year.bridge.adjustments + year.bridge.accountsAdded);
  assert.equal(year.groupFlows.some(flow => flow.from === flow.to), false);
});

test('The first tracked period starts on the first tracked day, with its opening balances as the start', () => {
  const tracked = [
    { id: 'spend', name: 'Spending', type: 'bank', balance_cents: 90000, archived: 0, created_at: '2026-08-20 10:00:00' },
    { id: 'safe', name: 'Safe', type: 'savings', balance_cents: 200000, archived: 0, created_at: '2026-08-20 10:00:00' },
    { id: 'pot', name: 'Pot', type: 'wallet', balance_cents: 10000, archived: 0, created_at: '2026-10-07 10:00:00' },
  ];
  const entries = [
    tx('o-spend', 'opening_balance', 100000, '2026-08-20', null, 'spend'),
    tx('o-safe', 'opening_balance', 200000, '2026-08-20', null, 'safe'),
    tx('coffee', 'expense', 500, '2026-08-20', 'spend'),
    tx('pay', 'income', 30000, '2026-09-01', 'spend'),
    tx('bills', 'expense', 39500, '2026-09-10', 'spend'),
    tx('o-pot', 'opening_balance', 10000, '2026-10-07', null, 'pot'),
  ];
  const build = key => buildAccountsReport({ period: reportPeriod(key, '2026-10-08'), accounts: tracked, transactions: entries, snapshots: [], firstDate: '2026-08-20' });
  const year = build('2026');
  assert.equal(year.period.trackedFrom, '2026-08-20');
  assert.equal(year.netWorth.start, 300000);
  // Same-day spending stays in the period; only the later account counts as added.
  assert.deepEqual({ ...year.bridge }, { income: 30000, spending: 40000, saved: -10000, adjustments: 0, accountsAdded: 10000 });
  assert.equal(year.netWorth.change, 0);
  assert.equal(year.netWorth.end, 300000);
  const august = build('2026-08');
  assert.equal(august.period.trackedFrom, '2026-08-20');
  assert.deepEqual([august.netWorth.start, august.netWorth.end, august.bridge.accountsAdded, august.bridge.spending], [300000, 299500, 0, 500]);
  const september = build('2026-09');
  assert.equal(september.period.trackedFrom, null);
  assert.equal(september.netWorth.start, 299500);
  assert.equal(september.bridge.accountsAdded, 0);
});

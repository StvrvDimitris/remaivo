import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const v3_versions=sqliteTable('v3_versions',{
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 effective_from: text('effective_from').notNull(),
 config_json: text('config_json').notNull(),
 created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
},t=>[index('v3_versions_user').on(t.user_id,t.effective_from)]);

export const v3_periods=sqliteTable('v3_periods',{
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 start_date: text('start_date').notNull(),
 end_date: text('end_date').notNull(),
 version_id: text('version_id').notNull(),
 funding_cents: integer('funding_cents').notNull(),
 created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
},t=>[uniqueIndex('v3_periods_user_id_start_date_end_date_unique').on(t.user_id,t.start_date,t.end_date)]);

export const v3_bucket_templates=sqliteTable('v3_bucket_templates',{
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 name: text('name').notNull(),
 kind: text('kind').notNull(),
 category_ids: text('category_ids').notNull().default('[]'),
 target_cents: integer('target_cents').notNull(),
 priority: integer('priority').notNull().default(0),
 rollover: text('rollover').notNull().default('none'),
 rollover_cap: integer('rollover_cap').notNull().default(0),
 destination_id: text('destination_id'),
 archived: integer('archived').notNull().default(0),
 archived_at: text('archived_at')
});

export const v3_bucket_periods=sqliteTable('v3_bucket_periods',{
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 period_id: text('period_id').notNull(),
 bucket_id: text('bucket_id').notNull(),
 name: text('name').notNull(),
 kind: text('kind').notNull(),
 category_ids: text('category_ids').notNull().default('[]'),
 target_cents: integer('target_cents').notNull(),
 priority: integer('priority').notNull().default(0),
 rollover: text('rollover').notNull().default('none'),
 rollover_cap: integer('rollover_cap').notNull().default(0),
 destination_id: text('destination_id'),
 released: integer('released').notNull().default(0)
},t=>[uniqueIndex('v3_bucket_periods_period_id_bucket_id_unique').on(t.period_id,t.bucket_id)]);

export const v3_assignments=sqliteTable('v3_assignments',{
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 transaction_id: text('transaction_id').notNull(),
 bucket_id: text('bucket_id').notNull(),
 amount_cents: integer('amount_cents').notNull()
},t=>[uniqueIndex('v3_assignments_user_id_transaction_id_bucket_id_unique').on(t.user_id,t.transaction_id,t.bucket_id)]);

export const v3_occurrences=sqliteTable('v3_occurrences',{
 counts_monthly: integer('counts_monthly').notNull().default(1),
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 source_kind: text('source_kind').notNull(),
 source_id: text('source_id').notNull(),
 scheduled_date: text('scheduled_date').notNull(),
 due_date: text('due_date').notNull(),
 title: text('title').notNull(),
 type: text('type').notNull(),
 amount_cents: integer('amount_cents').notNull(),
 paid_cents: integer('paid_cents').notNull().default(0),
 account_id: text('account_id'),
 destination_account_id: text('destination_account_id'),
 category_id: text('category_id'),
 committed: integer('committed').notNull().default(1),
 auto_post: integer('auto_post').notNull().default(0),
 status: text('status').notNull().default('upcoming'),
 transaction_id: text('transaction_id'),
 settlement_token: text('settlement_token')
},t=>[uniqueIndex('v3_occurrences_user_id_source_kind_source_id_scheduled_date_unique').on(t.user_id,t.source_kind,t.source_id,t.scheduled_date),index('v3_occurrence_user').on(t.user_id,t.status,t.due_date)]);

export const v3_events=sqliteTable('v3_events',{
 id: text('id').primaryKey(),
 user_id: text('user_id').notNull(),
 kind: text('kind').notNull(),
 detail: text('detail').notNull(),
 created_at: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`)
});

export const v3_payment_links=sqliteTable('v3_payment_links',{transaction_id:text('transaction_id').primaryKey(),user_id:text('user_id').notNull(),occurrence_id:text('occurrence_id').notNull()});

import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(),
});

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  accountCreatedAt: timestamp('account_created_at').notNull(),
});

export const payments = pgTable('payments', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  refundedMinor: bigint('refunded_minor', { mode: 'bigint' })
    .notNull()
    .default(0n),
  currency: text('currency').notNull(),
});

export const refundRequests = pgTable('refund_requests', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull(),
  paymentId: text('payment_id').notNull(),
  requesterId: text('requester_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  reasonCode: text('reason_code').notNull(),
  notes: text('notes'),
  state: text('state').notNull(),
  approvals: jsonb('approvals').$type<string[]>().notNull().default([]),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const ledger = pgTable('ledger', {
  id: serial('id').primaryKey(),
  refundId: text('refund_id').notNull().unique(),
  paymentId: text('payment_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
});

export const auditLog = pgTable('audit_log', {
  id: serial('id').notNull(),
  createdAt: timestamp('created_at').notNull(),
  tableName: text('table_name').notNull(),
  rowPk: text('row_pk').notNull(),
  operation: text('operation').notNull(),
  beforeData: jsonb('before_data'),
  afterData: jsonb('after_data'),
  actorId: text('actor_id').notNull(),
  requestId: text('request_id').notNull(),
  prevHash: text('prev_hash').notNull(),
  rowHash: text('row_hash').notNull(),
});

export const sensitiveColumns = pgTable('sensitive_columns', {
  tableName: text('table_name').notNull(),
  columnName: text('column_name').notNull(),
  sensitivity: text('sensitivity').notNull(),
  redactInAudit: boolean('redact_in_audit').notNull().default(false),
});

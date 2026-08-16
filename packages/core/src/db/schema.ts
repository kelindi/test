import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const refundReasonCode = pgEnum('refund_reason_code', [
  'duplicate',
  'fraud',
  'customer_request',
  'service_issue',
  'other',
]);
export const refundState = pgEnum('refund_state', [
  'pending_approval',
  'approved',
  'executing',
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
]);
export const approvalDecision = pgEnum('approval_decision', [
  'approved',
  'rejected',
]);
export const refundSource = pgEnum('refund_source', [
  'manual',
  'ticket',
  'api',
]);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  externalId: text('external_id').notNull().unique(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  accountCreatedAt: timestamp('account_created_at').notNull(),
});
export const payments = pgTable(
  'payments',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').notNull(),
    externalPaymentId: text('external_payment_id').notNull().unique(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    refundedMinor: bigint('refunded_minor', { mode: 'bigint' })
      .notNull()
      .default(0n),
    currency: text('currency').notNull(),
    capturedAt: timestamp('captured_at').notNull(),
    status: text('status').notNull(),
  },
  (table) => [unique().on(table.id, table.customerId)],
);
export const refundRequests = pgTable('refund_requests', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull(),
  paymentId: text('payment_id').notNull(),
  paymentSnapshot: jsonb('payment_snapshot').notNull(),
  requestedBy: text('requested_by').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  reasonCode: refundReasonCode('reason_code').notNull(),
  notes: text('notes'),
  state: refundState('state').notNull(),
  source: refundSource('source').notNull().default('manual'),
  externalReference: text('external_reference'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
export const refundApprovals = pgTable(
  'refund_approvals',
  {
    id: serial('id').primaryKey(),
    refundRequestId: text('refund_request_id').notNull(),
    approverId: text('approver_id').notNull(),
    decision: approvalDecision('decision').notNull(),
    reasonCode: refundReasonCode('reason_code').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [unique().on(table.refundRequestId, table.approverId)],
);
export const ledgerEntries = pgTable('ledger_entries', {
  id: serial('id').primaryKey(),
  refundRequestId: text('refund_request_id').notNull().unique(),
  paymentId: text('payment_id').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  direction: text('direction').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
export const outbox = pgTable('outbox', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: timestamp('next_attempt_at').notNull().defaultNow(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
export const providerCalls = pgTable('provider_calls', {
  id: serial('id').primaryKey(),
  refundRequestId: text('refund_request_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestPayload: jsonb('request_payload').notNull(),
  responsePayload: jsonb('response_payload'),
  status: text('status').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
export const accessLog = pgTable('access_log', {
  id: serial('id').primaryKey(),
  actorId: text('actor_id').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

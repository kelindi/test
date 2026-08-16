import crypto from 'node:crypto';

import { can, type Actor } from './authz';
import { auditEvent, logAccess, readAs, type DatabaseClient } from './db';
import { kycTransitions, StateMachine } from './state-machine';

export type KycQueueRow = {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  riskLevel: string;
  state: string;
  submitterId: string;
  age: string;
};

export type KycDocument = {
  id: string;
  kycCaseId: string;
  docType: 'id_front' | 'id_back' | 'proof_of_address' | 'selfie';
  mockImagePath: string;
  createdAt: Date;
};

export type KycCaseDetail = {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerExternalId: string;
  accountCreatedAt: Date;
  submittedBy: string;
  riskLevel: string;
  notes: string | null;
  state: string;
  createdAt: Date;
  updatedAt: Date;
  documents: KycDocument[];
};

export type CreateKycInput = {
  customerId: string;
  submittedBy: string;
  riskLevel: 'low' | 'medium' | 'high';
  notes: string | null;
  idempotencyKey: string;
};

export type KycAction =
  | 'kyc:approve'
  | 'kyc:reject'
  | 'kyc:request_info'
  | 'kyc:submit';

export async function kycQueue(actor: Actor): Promise<KycQueueRow[]> {
  if (!can(actor, 'kyc:read')) throw new Error('Not authorized');
  return readAs(actor, async (client) => {
    const result = await client.query(
      `SELECT k.id, k.customer_id, c.name AS customer_name, c.email AS customer_email,
              k.risk_level, k.state, k.submitted_by, (now() - k.created_at)::text AS age
       FROM kyc_cases k
       JOIN customers c ON c.id = k.customer_id
       ORDER BY k.created_at ASC`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      riskLevel: row.risk_level,
      state: row.state,
      submitterId: row.submitted_by,
      age: row.age,
    }));
  });
}

export async function readKycCase(
  actor: Actor,
  kycCaseId: string,
  traceId: string = crypto.randomUUID(),
): Promise<KycCaseDetail | null> {
  if (!can(actor, 'kyc:read')) throw new Error('Not authorized');
  return readAs(actor, async (client) => {
    const caseRow = (
      await client.query(
        `SELECT k.*, c.external_id AS customer_external_id, c.name AS customer_name,
                c.email AS customer_email, c.account_created_at
         FROM kyc_cases k
         JOIN customers c ON c.id = k.customer_id
         WHERE k.id = $1`,
        [kycCaseId],
      )
    ).rows[0];
    if (!caseRow) return null;

    const docs = await client.query(
      'SELECT * FROM kyc_documents WHERE kyc_case_id = $1 ORDER BY doc_type',
      [kycCaseId],
    );

    await logAccess(client, actor, 'kyc_case', kycCaseId, traceId);
    await logAccess(client, actor, 'customer', caseRow.customer_id, traceId);

    return {
      id: caseRow.id,
      customerId: caseRow.customer_id,
      customerName: caseRow.customer_name,
      customerEmail: caseRow.customer_email,
      customerExternalId: caseRow.customer_external_id,
      accountCreatedAt: caseRow.account_created_at,
      submittedBy: caseRow.submitted_by,
      riskLevel: caseRow.risk_level,
      notes: caseRow.notes,
      state: caseRow.state,
      createdAt: caseRow.created_at,
      updatedAt: caseRow.updated_at,
      documents: docs.rows.map((row) => ({
        id: row.id,
        kycCaseId: row.kyc_case_id,
        docType: row.doc_type,
        mockImagePath: row.mock_image_path,
        createdAt: row.created_at,
      })),
    };
  });
}

export async function createKycCase(
  client: DatabaseClient,
  input: CreateKycInput,
): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO kyc_cases
      (id, customer_id, submitted_by, risk_level, notes, state, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'pending_review', $6)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      id,
      input.customerId,
      input.submittedBy,
      input.riskLevel,
      input.notes?.trim() || null,
      input.idempotencyKey,
    ],
  );
  const existing = (
    await client.query('SELECT id FROM kyc_cases WHERE idempotency_key = $1', [
      input.idempotencyKey,
    ])
  ).rows[0];
  return existing.id as string;
}

export async function decideKycCase(
  client: DatabaseClient,
  actor: Actor,
  kycCaseId: string,
  action: KycAction,
  comment: string | null = null,
  traceId: string = crypto.randomUUID(),
): Promise<string> {
  const kyc = (
    await client.query('SELECT * FROM kyc_cases WHERE id = $1 FOR UPDATE', [
      kycCaseId,
    ])
  ).rows[0];
  if (!kyc) throw new Error('KYC case not found');

  const resource = {
    state: kyc.state,
    requesterId: kyc.submitted_by,
    approvalActorIds: [],
  };

  const stateMap: Record<KycAction, string> = {
    'kyc:approve': 'approved',
    'kyc:reject': 'rejected',
    'kyc:request_info': 'needs_more_info',
    'kyc:submit': 'pending_review',
  };
  const next = stateMap[action];

  const machine = new StateMachine(kycTransitions);
  machine.transition(
    kyc.state,
    next,
    actor,
    action,
    [{ transition: 'kyc:create', actorId: kyc.submitted_by }],
    resource,
  );

  await client.query(
    `UPDATE kyc_cases
     SET state = $1, notes = COALESCE($2, notes), updated_at = now()
     WHERE id = $3`,
    [next, comment?.trim() || null, kycCaseId],
  );

  await auditEvent(
    client,
    'kyc.transitioned',
    actor,
    { kycCaseId, action, next, comment: comment?.trim() || null },
    traceId,
  );

  return next;
}

# Internal tools portal proof of concept

A small monorepo showing how internal tools can be built in the company's own stack with a mix of database and typed application-layer governance: PostgreSQL RLS enforces coarse role boundaries, triggers make audit records append-only for the application role, and a typed `can()` / state machine layer enforces action, state, and separation-of-duty rules. The goal is to compare this approach against low-code platforms like Power Apps for tools where engineering depth and auditability matter.

## What it does

- A shared portal (`apps/web`) gated by role capability checks.
- Three internal tools demonstrating the same primitives:
  - **Refunds** — customer-charge lookup, dual approval for high-value refunds, provider execution, and a hash-chained audit trail.
  - **Feature flags** — create, toggle, and review feature flags with state transitions and audit.
  - **KYC** — stage and review identity/submission documents before approval.
- Reusable primitives in `packages/core`: actor-context Postgres clients, RLS policies for role-level boundaries, a typed capability matrix, state machine, deduplication-keyed outbox, and hash-chained audit log.

## Run it locally

### Prerequisites

- Node.js 20.x
- pnpm 9.15.5
- PostgreSQL 14+

Create the database and roles as a PostgreSQL superuser:

```sql
CREATE ROLE devin_powerapps_owner LOGIN PASSWORD 'owner_dev_password';
CREATE ROLE devin_powerapps_app LOGIN PASSWORD 'app_dev_password';
CREATE DATABASE devin_powerapps_poc OWNER devin_powerapps_owner;
CREATE DATABASE devin_powerapps_poc_test OWNER devin_powerapps_owner;
```

### Environment

```bash
cp .env.example .env
cp .env apps/web/.env.local
```

The `apps/web/.env.local` copy is required when using `pnpm dev` because the
dev script runs Next.js from `apps/web`.

Required variables:

- `DATABASE_URL` — app connection as `devin_powerapps_app`.
- `DATABASE_OWNER_URL` — setup/migration connection as `devin_powerapps_owner`.
- `AUTH_SECRET` — Auth.js session secret.
- `AUTH_TRUST_HOST=true` — for local Auth.js.
- `REFUND_APPROVAL_THRESHOLD_MINOR` — refund amount requiring two approvals.

### Setup and start

```bash
pnpm install
pnpm db:setup
DATABASE_URL="postgres://devin_powerapps_app:app_dev_password@localhost:5432/devin_powerapps_poc_test?sslmode=disable" \
DATABASE_OWNER_URL="postgres://devin_powerapps_owner:owner_dev_password@localhost:5432/devin_powerapps_poc_test?sslmode=disable" \
pnpm db:setup
pnpm dev
```

Open http://localhost:3000. To run the production build instead, use
`pnpm build` followed by `cd apps/web && npx next start -p 3000`.

### Demo accounts

| Role             | Email                  | Password               |
| ---------------- | ---------------------- | ---------------------- |
| Support agent    | `support@example.com`  | `support-password`     |
| Finance reviewer | `finance1@example.com` | `finance-password`     |
| Finance reviewer | `finance2@example.com` | `finance-two-password` |
| KYC reviewer     | `kyc@example.com`      | `kyc-password`         |
| Admin            | `admin@example.com`    | `admin-password`       |
| Demo (all tools) | `demo@example.com`     | `demo-password`        |
| Engineering      | `eng@example.com`      | `engineering-password` |

Switch roles by visiting `/api/auth/signout` and logging in again.

## Verify

```bash
pnpm db:setup && pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Tests run against `devin_powerapps_poc_test` and never touch the development database.

## Adding a new tool

1. Add tool tables to the schema and register columns requiring audit redaction in `sensitive_columns` with `redact_in_audit = true`.
2. Force RLS for coarse role boundaries and use triggers / foreign keys for structural invariants (audit immutability for the application role, valid state values, composite keys).
3. Use `withActor`/`readAs` to set Postgres actor context on the connection; use `defineAction` to validate input, check `can()`, wrap the mutation in a transaction, and audit; `can()` enforces action, state, and separation-of-duty rules.
4. Put permissions in `can()` and transitions in the declarative state machine.
5. Add one entry to the portal tool registry with the route and gating capability.
6. Emit business events with `auditEvent` and log PII reads with `logAccess`.
7. Put external side effects behind an interface and dispatch them through the outbox with persisted idempotency keys.
8. Add an auditor-facing test for every security or consistency claim.

## Limitations

- This is a proof of concept, not production infrastructure.
- There is no user provisioning, invite, password reset, or role-management UI.
- Payment provider and KYC document verification are mocked.

## Operational URLs

- Admin export: `/refunds/export?format=json&table=refund_requests&rowPk=<id>`
- Worker trigger: `POST /api/worker` while signed in as admin

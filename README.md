# Internal tools portal proof of concept

This repository is a small monorepo for an internal-tools portal. The web
application lives in `apps/web`; reusable audit, authorization, actor-scoped
data access, money, state-machine, and outbox primitives live in
`packages/core`.

## Local setup from a fresh clone

### Prerequisites

- Node.js 20.x
- pnpm 9.15.5 (the version pinned in `package.json`)
- PostgreSQL 14 or newer

On this machine, pnpm is installed at
`/home/ubuntu/.local/node_modules/.bin/pnpm` but is not on the default `PATH`.
Use that absolute path, or add its directory to `PATH`, for example:

```bash
export PATH="/home/ubuntu/.local/node_modules/.bin:$PATH"
```

### Create the local database and roles

Create the database and the two roles before running the setup script. Use a
PostgreSQL administrator account for these commands:

```sql
CREATE ROLE devin_powerapps_owner LOGIN PASSWORD 'owner_dev_password';
CREATE ROLE devin_powerapps_app LOGIN PASSWORD 'app_dev_password';
CREATE DATABASE devin_powerapps_poc OWNER devin_powerapps_owner;
```

The setup script owns and recreates the proof-of-concept schema as
`devin_powerapps_owner`. The application connects as
`devin_powerapps_app`, which does not own the business tables and cannot
directly mutate audit records.

### Configure environment variables

From the repository root:

```bash
cp .env.example .env
```

Set each variable in `.env`:

- `DATABASE_URL`: application connection string using
  `devin_powerapps_app`.
- `DATABASE_OWNER_URL`: setup/migration connection string using
  `devin_powerapps_owner`.
- `AUTH_SECRET`: long random secret used by Auth.js sessions.
- `AUTH_TRUST_HOST`: set to `true` for this local Auth.js deployment.
- `REFUND_APPROVAL_THRESHOLD_MINOR`: refund amount in minor currency units
  at which two approvals are required.

The example URLs use
`sslmode=require&uselibpqcompat=true` for the local self-signed PostgreSQL
certificate. Production deployments should use normal certificate-chain
verification.

### Install, seed, and run

```bash
pnpm install
pnpm db:setup
pnpm dev
```

`pnpm db:setup` is rerunnable. It drops and recreates the proof-of-concept
objects and reseeds the demo data. Open <http://localhost:3000>; an
unauthenticated visit goes to the shared portal login.

The `apps/*` workspace contains the web application. Database setup remains a
root script because it operates on `packages/core/src/db/setup.ts` and the
root `drizzle/0000_initial.sql` schema.

### Demo accounts and switching roles

Sign in at `/login` with one of these seeded accounts:

| Role             | Email                  | Password               |
| ---------------- | ---------------------- | ---------------------- |
| Support agent    | `support@example.com`  | `support-password`     |
| Finance reviewer | `finance1@example.com` | `finance-password`     |
| Finance reviewer | `finance2@example.com` | `finance-two-password` |
| Admin            | `admin@example.com`    | `admin-password`       |

There is deliberately no account provisioning, invite, password-reset, or
role-management UI. There is also no logout link in the throwaway UI. To
switch roles, visit `/api/auth/signout`, follow Auth.js's sign-out page, then
return to `/login`.

The portal home is generated from the registered tools and the existing
capability policy. A tool is listed only when the signed-in actor passes its
`can()` capability check.

### URL-only entry points

- Audit export:
  `/refunds/export?format=json&table=refund_requests&rowPk=<id>`
- Worker trigger: `POST /api/worker` while signed in as the admin account

The worker has no UI button. The export route is admin-only.

### Verification commands

Run these from the repository root:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For a clean database and complete local verification:

```bash
pnpm db:setup
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The repository includes
`.agents/skills/testing-refunds-poc/SKILL.md` as an untracked local testing
skill. It documents the manual login, role-switching, export, worker, and
database verification path; it is intentionally not part of the deliverable
commits.

## Audit and security limits

Business-table writes require actor and request session variables. Security
definer triggers record redacted before/after snapshots in a time-partitioned
hash chain. Application events and read access are recorded separately, with
application events also hash chained.

A PostgreSQL superuser can rewrite the audit chain, so production deployments
must anchor hashes in external WORM storage. The transaction advisory lock
serializes audit writes and must be revisited for high-throughput workloads.

## Test-to-claim mapping

The auditor-facing claims are executable in
`packages/core/src/__tests__/core.test.ts` and
`packages/core/src/__tests__/audit-kit.test.ts`, including:

- role × action × state authorization and capability-matrix coverage;
- requester/reviewer separation and duplicate-reviewer prevention;
- authentication and generic login-failure auditing;
- customer PII access logging and audit redaction;
- audit INSERT/UPDATE/DELETE completeness and hash-chain verification;
- wrong-role RLS visibility and audit-table mutation denial;
- database-level customer/payment, currency, amount, and notes invariants;
- BigInt money boundaries and refundable-balance reconciliation;
- idempotent outbox/provider/ledger execution;
- concurrent outbox claiming;
- timeout-then-succeeded sweeper reconciliation;
- raw-client import boundary enforcement.

## Adding a new tool

1. Add the tool's tables and sensitivity classifications to the schema.
2. Enable and force RLS; write policies keyed to actor session variables.
3. Use `withActor`/`readAs` for database access and `defineAction` for
   mutations.
4. Put permissions in `can()` and transitions in the declarative state
   machine.
5. Add one entry to the portal tool registry with its route and gating
   capability.
6. Use `auditEvent` for business events and `logAccess` for reads.
7. Put external side effects behind an interface and dispatch them through
   the outbox with persisted idempotency keys.
8. Add an auditor-facing test for every security or consistency claim.

The feature-flag application is intentionally not included; it will be built
on these primitives so reuse savings can be measured honestly.

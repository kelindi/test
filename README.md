# Internal refunds tools proof of concept

This repository demonstrates a backend-first refunds workflow built on reusable
audit, authorization, actor-scoped data access, money, state-machine, and
outbox primitives.

## Setup

Prerequisites: Node.js 20, pnpm, and PostgreSQL 14 or newer.

```bash
cp .env.example .env
pnpm install
pnpm db:setup
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm db:setup` is safe to rerun. It recreates the proof-of-concept tables and
seed data in the configured database. The database must already contain the
owner and app roles:

- `devin_powerapps_owner` owns schema objects and runs setup.
- `devin_powerapps_app` is used by the application and does not own business
  tables or mutate audit records.

Database connections use TLS. Local development accepts the self-signed
certificate with `sslmode=require&uselibpqcompat=true`; production should use
normal certificate verification. At-rest encryption is a platform concern
(for example, an encrypted RDS, Cloud SQL, or Supabase volume with a KMS key).

## Demo login

Open `/login`, then use one of:

| Role             | Email                  | Password               |
| ---------------- | ---------------------- | ---------------------- |
| Support agent    | `support@example.com`  | `support-password`     |
| Finance reviewer | `finance1@example.com` | `finance-password`     |
| Finance reviewer | `finance2@example.com` | `finance-two-password` |
| Admin            | `admin@example.com`    | `admin-password`       |

There is deliberately no account provisioning, invite, password-reset, or role
management UI.

## Audit guarantee

Business-table writes require actor and request session variables. Security
definer triggers record redacted before/after snapshots in a time-partitioned
hash chain. The transaction advisory lock serializes chain writes. Application
events and read access are recorded separately, with application events also
hash chained. Audit exports verify the business audit chain before returning.

The chain is not a replacement for external tamper-proof storage: a PostgreSQL
superuser can rewrite it. Production deployments should anchor hashes in WORM
storage. The advisory lock serializes audit writes and must be revisited for
high-throughput workloads.

## Test-to-claim mapping

`packages/core/src/__tests__/core.test.ts` names the auditor-facing guarantees
currently covered:

- authorization matrix: role capabilities and admin approval denial;
- state-machine SoD: distinct actors are required for protected transitions;
- money boundaries: exact BigInt minor-unit arithmetic;
- raw-client import guard: application code uses core DAL boundaries;
- concurrent writes: serialized audit-chain writes remain verifiable;
- missing actor: anonymous database writes fail;
- database RLS: wrong-role reads return no rows;
- tamper detection: changing an audit row invalidates verification;
- provider idempotency: repeated keys produce one provider call.

## Adding a new tool

1. Define the tool's tables and sensitivity classifications in the migration.
2. Enable and force RLS; write policies keyed to actor session variables.
3. Use `withActor`/`readAs` for all database access and `defineAction` for
   mutations.
4. Put permissions in `can()` and transitions in the declarative state machine.
5. Use `auditEvent` for business events and `logAccess` for reads.
6. Put external side effects behind an interface and dispatch them through the
   outbox with persisted idempotency keys.
7. Add an auditor-facing test for every security or consistency claim.

The feature-flag application is intentionally not included; it will be built
by hand on these primitives so reuse savings can be measured honestly.

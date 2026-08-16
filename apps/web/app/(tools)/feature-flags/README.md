# Feature-flag management portal

Management-only proof-of-concept for listing, creating, and toggling product feature flags. Built on `packages/core` primitives: actor-scoped DB access, PostgreSQL RLS, `can()` authorization, and hash-chained audit logging.

## Routes

- `/feature-flags` — list flags, inline enable/disable
- `/feature-flags/new` — create a flag
- `/feature-flags/[id]` — flag detail and change history

## Roles

- `engineering_team` — `flag:read`, `flag:toggle`, `flag:create`
- `admin` — `flag:read`, `flag:create`, `audit:read`
- `demo_admin` — all capabilities (demo-only master role)
- `support_agent`, `finance_reviewer` — no flag access; direct navigation redirects to `/login`

## Run

```bash
pnpm install
pnpm db:setup
pnpm dev
```

Open `http://localhost:3000` and sign in:

- `demo@example.com` / `demo-password` — full access
- `eng@example.com` / `engineering-password` — engineering view

## Verify

```bash
pnpm db:setup
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The product-facing read path is intentionally out of scope; consumer products would use a separate data plane with a non-human actor and RLS policy.

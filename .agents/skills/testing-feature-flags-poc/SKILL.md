---
name: Test the feature-flag portal (devin-powerapps-poc)
description: End-to-end testing guide for the /feature-flags tool, covering the dev server, demo accounts, and the browser-input fallback used in this environment.
---

# Testing the feature-flag portal

Use this skill when verifying the `Feature Flags` tool in `apps/web/app/(tools)/feature-flags/`.

## Environment setup

1. From the repo root, run the dev DB seed:
   - `pnpm db:setup` (needs `DATABASE_OWNER_URL`).
2. Start the dev server:
   - `pnpm dev` starts `next dev apps/web` on `http://localhost:3000`.

## Sanity checks

`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` should pass. Note that `pnpm test` uses `devin_powerapps_poc_test` (set up automatically if `DATABASE_TEST_URL` is not set). `pnpm build` may emit a legacy ESLint options warning but should return exit code `0`.

## Demo accounts

| Email | Password | Role | flag:read | flag:toggle | flag:create | audit:read |
|---|---|---|---|---|---|---|
| `eng@example.com` | `engineering-password` | `engineering_team` | yes | yes | yes | no |
| `admin@example.com` | `admin-password` | `admin` | yes | no | yes | yes |
| `support@example.com` | `support-password` | `support_agent` | no | no | no | no |
| `finance1@example.com` | `finance-password` | `finance_reviewer` | no | no | no | no |

## Gotchas

- The Devin-managed Chrome wrapper accepts navigation (`window.location.href`) and `browser_console` JavaScript, but native OS-level mouse clicks and keyboard typing do not visibly affect the page. Drive forms by setting `.value` and calling `.requestSubmit()` / `.click()` through `browser_console`.
- When selecting submit buttons, scope to `main` to avoid accidentally clicking the header **Sign out** form button (`header form button`).
- The `Feature Flags` routes guard `flag:read`; users without it (support/finance) are redirected to `/login`. `/feature-flags/new` also requires `flag:create`; users with `flag:read` but not `flag:create` are redirected to `/feature-flags`.
- Engineering and admin users can create flags via `/feature-flags/new`.
- Admin detail change history renders audit entries; engineering users see **No audit entries** because `audit:read` is denied.

## Devin Secrets Needed

- `DATABASE_URL`
- `DATABASE_OWNER_URL`
- `AUTH_SECRET`
- `AUTH_TRUST_HOST=true`

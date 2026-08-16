---
name: Testing the KYC portal
description: How to stand up and end-to-end test the KYC portal in the devin-powerapps-poc monorepo.
---

# Devin Secrets Needed
- None for the local Docker setup; use the dev database password defined in your environment.

# Local environment
- Postgres 15 is expected on `localhost:5432` with a container named `pg-devin`.
- Required roles/db are created via standard `psql`:
  - `devin_powerapps_owner` with the password from `DATABASE_OWNER_URL`
  - `devin_powerapps_app` with the password from `DATABASE_URL`
  - database `devin_powerapps_poc` owned by `devin_powerapps_owner`
- The Next.js app needs `DATABASE_URL`, `DATABASE_OWNER_URL`, `AUTH_SECRET`, and `AUTH_TRUST_HOST=true`.
- Because this Docker Postgres has no SSL, use `sslmode=disable` in the connection strings.
- `dotenv/config` loads `.env`, while `pnpm dev` loads `.env.local`. Create `.env.local` (or source it) so `pnpm db:setup` and `pnpm dev` see the same variables.

# Demo accounts
| Email | Password | Role |
| --- | --- | --- |
| support@example.com | support-password | support_agent |
| kyc@example.com | kyc-password | kyc_reviewer |
| admin@example.com | admin-password | admin |

# Useful routes
- Login: `/login`
- Sign out: `/api/auth/signout`
- KYC queue: `/kyc`
- New KYC case: `/kyc/new`
- Case detail: `/kyc/<id>`
- Admin audit export (JSON): `/refunds/export?format=json&table=kyc_cases&rowPk=<id>`

# Test harness quirks
- The Next.js client router may not respond to the `computer` tool's synthetic `left_click` on `<Link>` elements. If clicks do not navigate, use the browser console to call `document.querySelector('a[href="..."]').click()` or `form.requestSubmit()`.
- Form submissions through `requestSubmit()` still exercise real server actions and generate audit rows.
- To role-switch, navigate to `/api/auth/signout`, confirm the sign-out form, then sign in as the next account.

# Known product caveats to verify
- Newly created KYC cases should now automatically get the four `kyc_documents` rows (`id_front`, `id_back`, `proof_of_address`, `selfie`) and display them in the detail page.
- The KYC detail page should render an **Audit history** card when viewed by an `admin`.
- If the Postgres container loses its role passwords, the app role passwords can be reset with the `postgres` superuser using the passwords from `DATABASE_OWNER_URL` and `DATABASE_URL`:
  `ALTER ROLE devin_powerapps_owner WITH PASSWORD '<owner_password>';`
  `ALTER ROLE devin_powerapps_app WITH PASSWORD '<app_password>';`

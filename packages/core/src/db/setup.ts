import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { scryptSync } from 'node:crypto';

const owner = new pg.Client({
  connectionString: process.env.DATABASE_OWNER_URL,
});
await owner.connect();
await owner.query(
  fs.readFileSync(path.join(process.cwd(), 'drizzle/0000_initial.sql'), 'utf8'),
);
await owner.query(
  "SELECT set_config('app.current_actor_id', 'seed', false), set_config('app.current_actor_role', 'admin', false), set_config('app.request_id', 'seed', false)",
);

const passwordHash = (password: string) =>
  scryptSync(password, 'devin-powerapps-demo-salt', 64).toString('hex');

await owner.query(
  `INSERT INTO users (id, email, name, password_hash, role) VALUES
   ('user_support', 'support@example.com', 'Support Agent', $1, 'support_agent'),
   ('user_finance_1', 'finance1@example.com', 'Finance Reviewer One', $2, 'finance_reviewer'),
   ('user_finance_2', 'finance2@example.com', 'Finance Reviewer Two', $3, 'finance_reviewer'),
   ('user_admin', 'admin@example.com', 'Administrator', $4, 'admin')
   ON CONFLICT (id) DO NOTHING`,
  [
    passwordHash('support-password'),
    passwordHash('finance-password'),
    passwordHash('finance-two-password'),
    passwordHash('admin-password'),
  ],
);

await owner.query(
  `INSERT INTO customers (id, name, account_created_at)
   VALUES ('customer_1', 'Demo Customer', now() - interval '2 years')
   ON CONFLICT DO NOTHING`,
);
await owner.query(
  `INSERT INTO payments (id, customer_id, amount_minor, currency)
   VALUES ('payment_1', 'customer_1', 250000, 'USD')
   ON CONFLICT DO NOTHING`,
);
await owner.end();
console.log('Database schema and seed are ready.');

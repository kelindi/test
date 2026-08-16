import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import crypto from 'node:crypto';

import { pool } from '@internal/core';

function verifyPassword(password: string, storedHash: string): boolean {
  const candidate = crypto
    .scryptSync(password, 'devin-powerapps-demo-salt', 64)
    .toString('hex');
  return crypto.timingSafeEqual(
    Buffer.from(candidate),
    Buffer.from(storedHash),
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials) {
        const email = String(credentials?.email ?? '');
        const password = String(credentials?.password ?? '');
        const result = await pool.query(
          'SELECT id, email, name, password_hash, role FROM users WHERE email = $1',
          [email],
        );
        const user = result.rows[0];
        if (!user || !verifyPassword(password, user.password_hash)) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.role = user.role;
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? '';
        session.user.role = token.role as string;
      }
      return session;
    },
  },
  session: { strategy: 'jwt' },
});

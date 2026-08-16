import 'next-auth';
import type { Role } from '@internal/core';

declare module 'next-auth' {
  interface User {
    role: Role;
  }

  interface Session {
    user: {
      id: string;
      role: Role;
    } & Session['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role?: Role;
  }
}

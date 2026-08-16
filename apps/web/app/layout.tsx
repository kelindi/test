import './globals.css';

import { AppHeader } from '@/components/app-header';
import { actorFromSession } from '@/lib/auth';
import { auth } from '../auth';

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  const actor = actorFromSession(session);

  return (
    <html lang="en">
      <body className="font-sans">
        {actor && <AppHeader actor={actor} email={session?.user.email} />}
        {children}
      </body>
    </html>
  );
}

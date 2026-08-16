import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '../auth';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { availableTools } from '../tool-registry';

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const actor = {
    id: session.user.id,
    role: session.user.role as 'support_agent' | 'finance_reviewer' | 'admin',
  };
  const tools = availableTools(actor);

  return (
    <main>
      <h1>Internal tools</h1>
      <p>Signed in as {session.user.email}</p>
      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        {tools.map((tool) => (
          <Card key={tool.id}>
            <CardHeader>
              <CardTitle>{tool.name}</CardTitle>
              <Badge>{tool.capability}</Badge>
            </CardHeader>
            <CardContent>
              <Link href={tool.route}>Open tool</Link>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}

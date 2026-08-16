import Link from 'next/link';
import { redirect } from 'next/navigation';

import { actorFromSession } from '@/lib/auth';
import { auth } from '../auth';
import { availableTools } from '../tool-registry';

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const actor = actorFromSession(session);
  if (!actor) redirect('/login');
  const tools = availableTools(actor);

  return (
    <main className="mx-auto max-w-[1100px] px-6 py-10">
      <h1 className="text-xl font-semibold leading-7">Internal tools</h1>
      <section className="mt-6 divide-y rounded-md border">
        {tools.map((tool) => (
          <div
            key={tool.id}
            className="flex items-center justify-between gap-6 px-4 py-4"
          >
            <div>
              <h2 className="text-sm font-medium">{tool.name}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {tool.description}
              </p>
            </div>
            <Link
              href={tool.route}
              className="text-sm font-medium underline underline-offset-4"
            >
              Open
            </Link>
          </div>
        ))}
      </section>
    </main>
  );
}

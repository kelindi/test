import { capabilityMatrix } from '@internal/core';
import { auth } from '../../../../auth';

export default async function CapabilitiesPage() {
  const session = await auth();
  if (session?.user?.role !== 'admin') return <main>Forbidden</main>;
  const rows = capabilityMatrix();
  return (
    <main>
      <h1>Role capabilities</h1>
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Action</th>
            <th>States</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.role}-${row.action}`}>
              <td>{row.role}</td>
              <td>{row.action}</td>
              <td>{row.states?.join(', ') ?? 'all'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

# Role extension proposal

## Current friction

Adding a role currently requires changing the TypeScript role union, the
`users.role` check constraint, the `can()` policy table, and each SQL RLS
policy that names permitted roles. The repeated SQL edits are the main source
of drift and make a small role change require a migration.

## Proposed mechanism

Create owner-managed tables:

- `roles (role text primary key)`
- `role_capabilities (role text references roles, action text, state text null, primary key (...))`

Keep the application authorization policy table generated from the same
capability rows (or generated during setup), rather than maintaining a second
hand-written role/action list. RLS policies would use a shared
`has_capability(action, resource_state)` `SECURITY DEFINER` function that checks
the session role against `role_capabilities`. Resource-specific predicates
(requester ownership, segregation of duties, and row relationships) would
remain explicit in the individual policy, while role membership would no
longer be repeated in every policy.

Adding a role would then be one data declaration in an owner migration:

1. Insert the role into `roles`.
2. Insert its capabilities into `role_capabilities`.
3. Add any role-specific resource predicate only if the new role needs
   semantics beyond capability membership.

## Tradeoffs

- **Database backstop:** RLS remains independent of `can()`. A session role
  without a capability still receives no rows or cannot write. The
  `SECURITY DEFINER` helper must have a fixed `search_path`, be owned by the
  schema owner, and be granted only to the application role.
- **Auditability:** A capability lookup is less immediately readable than a
  policy listing every role. The helper and capability tables must therefore be
  documented, exported, and covered by tests that verify every business table
  uses the helper where intended.
- **Operational safety:** Capability changes become data migrations and require
  change control, seed validation, and cache invalidation if authorization
  decisions are cached.
- **Typed application policy:** TypeScript can retain a generated role/action
  type for compile-time safety, but runtime authorization must treat the
  database capability rows as authoritative. A build step should fail if the
  generated union and seeded capability declarations diverge.
- **Resource predicates remain necessary:** A generic capability table cannot
  express “finance may approve only another reviewer’s request” by itself.
  Those predicates stay explicit in `can()` and in RLS, preserving the
  auditor-visible invariants.

This proposal is intentionally not implemented until the role model and the
desired migration workflow are approved.

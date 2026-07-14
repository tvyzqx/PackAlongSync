# Client sync fix: stop pushing non-owned server-managed rows

**Audience:** the PackGuide/PackAlong app team (Flutter client, `features/sync/`).
**Status:** required. A server-side stopgap is live (migration `021_member_write_tolerance.sql`); this is the durable fix that lets that stopgap be retired.

## Symptom

A member who joins a circle (or is removed and re-added) shows as **"local"** / never
syncs. Their profile, items, everything stay unsynced on their device, and on other
members' devices they appear as an unsynced/local participant. Reproduced live on
2026-07-14 for a member after an accidental remove + re-add from a shared circle —
they re-joined four times trying to make it "take".

## Root cause

The push half of the sync loop (`features/sync/remote_sync_service.dart`) uploads the
whole local dataset as per-table upserts, **including rows of the server-managed
identity tables `circles`, `circle_members` and `profiles`** — even for rows the user
does not own. The sync engine marks *pulled foreign rows* dirty and re-pushes them, so
after a share each device tries to write back rows belonging to the other party. Those
tables reject non-owned writes by RLS:

| table            | INSERT check                     | UPDATE                                   |
|------------------|----------------------------------|------------------------------------------|
| `circles`        | `created_by = auth.uid()`        | `is_circle_owner(id)`                    |
| `circle_members` | `is_circle_owner(circle_id)`     | `is_circle_owner(circle_id)`             |
| `profiles`       | `user_id = auth.uid() OR user_id IS NULL` | own, or circle-owner of the profile |

`INSERT ... ON CONFLICT DO UPDATE` always enforces the **INSERT** WITH CHECK even when it
resolves to an update, so these fail on the insert gate. Because the client applies the
push as **one batch**, a single rejected row aborts the entire push. None of the local
rows get their `synced_at` stamped, so the app keeps showing them — and the member — as
"local", and nothing reaches the server. This strands **both** devices:

- the **member's** push contains the owner's circle (`created_by = owner`) and every
  other member's account profile;
- the **owner's** push contains the joined member's account profile
  (`user_id = member`).

That is why a joined member shows as "local" on the *owner's* device too, not only their
own.

Two independent client bugs combine here:

1. **Over-broad push set** — the client pushes rows it has no authority to write.
   Circles and memberships are mutated *only* through edge functions
   (`pa-create-circle`, `pa-join-circle`, `pa-remove-member`, `pa-delete-circle`), never
   by a direct client upsert. The client already receives these rows on pull; it should
   treat them as **pull-authoritative** and not push back the ones it doesn't own.
2. **All-or-nothing push** — one rejected row fails the whole batch and blocks
   `synced_at` for unrelated rows.

## Required changes

### 1. Do not push server-managed rows you don't own

In the push builder, exclude from the `circles`, `circle_members` and `profiles` upsert
payloads any row where the current user is **not** the owner:

- `circles`: push a row only if `created_by == currentAuthUserId`.
- `circle_members`: push a row only if the current user is an **owner** of that
  `circle_id` (same predicate the app already uses to gate owner-only UI).
- `profiles`: push a row only if `user_id == currentAuthUserId` **or** `user_id == null`
  (a guest profile the user manages). Never push another account holder's profile.

Non-owned circles/memberships become **pull-only**: they arrive via the edge-function
responses and the incremental pull, and local mutations to them are never uploaded.
(Owner-initiated changes — rename, recolor, add/remove member — must go through the
existing edge functions, not a raw circles/circle_members upsert.)

This also means: **membership and circle lifecycle go through the edge functions**, which
now cover the full set — add (`pa-join-circle`, reactivates a soft-deleted member),
remove (`pa-remove-member`), delete circle (`pa-delete-circle`), and erase a
participant's data (`pa-delete-participant-data`).

### 2. Make the push resilient to per-row rejects

Even after (1), a future policy or a race can reject a row. One rejected row must not
strand everything else:

- Push per table (or per row) with error isolation; a `42501` / RLS rejection on one
  table must not prevent other tables from uploading.
- Stamp `synced_at` **only on rows the server actually accepted.** Never mark a row
  synced because the batch "returned" — confirm per row.
- Surface a non-owned-row rejection as a no-op (drop it from the push set per change 1),
  not as a sync error the user sees.

## Interaction with the server stopgap (migration 021)

Until change 1 ships, the server tolerates these stray writes via `BEFORE` triggers that
turn a non-owner write into a **no-op**:

- `circles` / `circle_members` (migration **021**): the write gate is widened to members,
  and `guard_nonowner_circle` / `guard_nonowner_circle_member` revert every field of a
  non-owner write back to the stored values.
- `profiles` (migration **024**): `guard_nonowner_profile` skips an INSERT of a foreign
  account profile (`user_id` neither yours nor null) and reverts such an UPDATE. No RLS
  policy change was needed here.

This unblocks sync on both devices without weakening authorization (validated live: a
malicious upsert — rename + `deleted=true` + `created_by`/`user_id` theft + self-promote
to owner — is accepted yet changes nothing, while each user's edits to their **own** rows
still apply).

Once the client stops pushing non-owned rows, migrations 021 and 024 can be reverted
(restore the strict `circles_insert_self` / `circles_update_owner` / `circle_members_*_owner`
policies and drop the three guard triggers), or kept as defense-in-depth. Coordinate the
revert with an app-version cutover so older clients still on the raw-upsert path aren't
re-broken.

## Acceptance criteria

1. User B joins a circle owned by User A. On B's device every local row reaches
   `synced_at`; B is **not** shown as "local"; on A's device B appears as a synced
   account member.
2. A removes B (`pa-remove-member`) then re-adds B via a fresh invite. B's membership
   reactivates cleanly and B syncs — no repeated re-joins needed.
3. B (a non-owner) renames/recolors a circle locally: the change does not corrupt the
   server row and does not abort B's push. (With change 1, it is never pushed; with the
   stopgap alone, it is a server no-op.)
4. With migration 021 reverted, scenarios 1–2 still pass — proving the client no longer
   depends on server tolerance.

// packalong_client.ts
//
// The sync backend hosts several apps (packalong, familyfocal, rallye) in a
// single Supabase project, each isolated in its OWN Postgres schema. Every
// PackAlong edge function talks to the `packalong` schema — never `public`,
// never another app's schema. Creating the service-role client through this
// one clearly-named helper (and typing every helper signature with
// `PackalongClient`) makes that boundary explicit and impossible to confuse
// with familyfocal or rallye code. It also removes the
// "'packalong' is not assignable to 'public'" schema friction, because helper
// params now use the exact type the schema-scoped client actually has.
//
// This is the data-layer twin of the `pa-` endpoint prefix the app uses when
// invoking these functions (see CircleJoinBackendService.kEdgeFunctionPrefix):
// `pa-` disambiguates the function name, this disambiguates the schema.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Service-role Supabase client scoped to PackAlong's `packalong` DB schema.
 * Pass the in-cluster `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
 */
export function createPackalongAdmin(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey, { db: { schema: "packalong" } });
}

/** Exact type of the `packalong`-scoped client, for helper signatures. */
export type PackalongClient = ReturnType<typeof createPackalongAdmin>;

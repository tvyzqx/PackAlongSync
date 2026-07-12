# PackGuideSync

Self-hosted sync server for the **PackGuide** packing-list app.

PackGuide works fully offline by default. If you want to share trips and packing lists between multiple devices or family members, you need a sync server. This repository contains everything you need to run that server on your own infrastructure: a Supabase-based backend with the database schema, row-level-security policies, and edge functions that PackGuide expects.

> PackGuide does **not** ship a hosted sync service. You run your own. This is intentional — your data stays on your server.

---

## What you get

- **Postgres schema** for trips, items, persons, groups, tags, etc. (folder `supabase/migrations/`)
- **Row-level-security policies** so each account only sees its own data
- **Edge functions** for invitation tokens, joining trips via link/QR, and upgrading guest profiles into full accounts (`supabase/functions/`)
- **Realtime** support for live collaboration
- **Email/password auth** out of the box (magic-link optional)

The app side then connects to your server URL via **Settings → Data → Sync server**.

---

## Requirements

- A Linux server (any modern distribution) with at least 2 GB RAM and 20 GB disk
- A domain name pointing to that server (e.g. `sync.example.com`)
- Docker + Docker Compose
- An SMTP account for sending account/invitation emails (e.g. Postmark, Brevo, Mailgun, Amazon SES — anything that speaks SMTP)
- Basic command-line skills

If you also want to administer the database from your laptop:
- The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) (optional, makes migrations and function deploys easier)

---

## Setup

The setup follows the [official Supabase self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker) and adds the PackGuide-specific schema on top.

### 1. Install Supabase via Docker Compose

```bash
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
```

Edit `.env` and set at least:

| Variable | Notes |
|---|---|
| `POSTGRES_PASSWORD` | Strong random password |
| `JWT_SECRET` | At least 32 random characters |
| `ANON_KEY` | Generate from JWT_SECRET — see Supabase docs |
| `SERVICE_ROLE_KEY` | Generate from JWT_SECRET — see Supabase docs |
| `SITE_URL` | Public URL of your sync server, e.g. `https://sync.example.com` |
| `API_EXTERNAL_URL` | Same as `SITE_URL` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SENDER_NAME`, `SMTP_ADMIN_EMAIL` | Your SMTP provider |
| `ENABLE_EMAIL_SIGNUP` | `true` |
| `ENABLE_EMAIL_AUTOCONFIRM` | `false` (users must confirm their email) |

Put a reverse proxy (Caddy, nginx, Traefik) in front so that `https://sync.example.com` reaches the Supabase Kong gateway on port `8000`.

Start the stack:

```bash
docker compose up -d
```

Verify it's healthy:

```bash
docker compose ps
curl https://sync.example.com/auth/v1/health
```

### 2. Apply the PackGuide schema

The PackGuide migrations live in `supabase/migrations/` of **this** repository. Apply them in order:

**Option A — with the Supabase CLI** (recommended):

```bash
# from the root of this repository
supabase link --project-ref <your-project-ref>
supabase db push
```

**Option B — directly with `psql`**:

```bash
for f in supabase/migrations/*.sql; do
  psql "postgresql://postgres:${POSTGRES_PASSWORD}@localhost:5432/postgres" -f "$f"
done
```

Verify the tables exist:

```bash
psql "$DB_URL" -c "\dt public.*"
```

You should see `trips`, `items`, `persons`, `pack_containers`, `tags`, `participants`, `preset_containers`, and others.

### 3. Deploy the edge functions

All PackAlong v3 functions are deployed under the `pa-` slug so they don't
collide with the other apps (familyfocal, rallye) sharing this Supabase
project. The directory name **is** the deployed slug **is** the endpoint the
app calls — no renaming step. `_shared/` holds imported helpers only and is
not a deployable function.

```bash
# v3 circle / guest-share functions (invoked by the app with the pa- prefix)
supabase functions deploy pa-bootstrap-account
supabase functions deploy pa-create-circle
supabase functions deploy pa-delete-circle
supabase functions deploy pa-generate-circle-invite
supabase functions deploy pa-join-circle
supabase functions deploy pa-check-join-status
supabase functions deploy pa-generate-guest-share
supabase functions deploy pa-guest-view

# legacy functions (invoked without a prefix — keep their bare names)
supabase functions deploy claim-person
supabase functions deploy upgrade-guest-account
```

`pa-guest-view` renders the public read-only packing list; `pa-generate-guest-share`
mints its token plus the email-bound companion invite. Both rely on migrations
`019_profile_email` and `020_guest_share_links`, so run `supabase db push` first.

Set the join-token expiry (in minutes; default 7 days):

```bash
supabase secrets set JOIN_TOKEN_TTL_MINUTES=10080
```

### 4. Configure auth

In the Supabase dashboard (or via `supabase` CLI):

- **Auth → Providers → Email**: enabled, with confirmation
- **Auth → URL Configuration**:
  - Site URL: `https://sync.example.com`
  - Additional redirect URL: `https://packguide.app/auth/*` (deep link back to the app)
- **Auth → Email templates**: customize the confirmation/recovery emails if you want

Test by signing up with your own email — you should receive a confirmation message.

### 5. Connect the app

Open the PackGuide app on your phone:

1. Go to **Settings → Data → Sync server**
2. Enter:
   - **Server URL**: `https://sync.example.com`
   - **Anon key**: the `ANON_KEY` from your `.env`
3. Tap **Test connection** — should report success.
4. Tap **Save**, then restart the app.
5. Go to the owner-account screen, sign up with email + password, and confirm via email.
6. Create a trip on one device, then sign in with the same account on a second device — the trip should appear within seconds.

---

## Updating

When PackGuide ships new schema migrations, this repository is updated. To apply:

```bash
git pull
supabase db push   # or re-run new files via psql
supabase functions deploy <changed-functions>
```

The app handles backward-compatible schema changes automatically; check release notes for breaking changes.

---

## Troubleshooting

**App shows "no connection"**
Verify `https://<your-server>/auth/v1/health` returns `200` from outside your server. Check reverse-proxy SSL certificate is valid.

**Sign-up email never arrives**
Check Supabase Auth logs (`docker compose logs auth`). Most common cause is incorrect SMTP credentials. Test SMTP independently with `swaks` or similar.

**Trips don't sync between devices**
Both devices must be signed in with the same email account. Guest profiles created locally on a device only sync after they've been "claimed" by an account (via the Edge Function `upgrade-guest-account`, triggered from inside the app).

**Realtime doesn't update other devices live**
Verify `realtime` is enabled in `config.toml` and the `supabase-realtime` container is running. Polling fallback (every 20 s) should still work even without realtime.

---

## Project structure

```
supabase/
├── config.toml             # Supabase project config (port assignments, etc.)
├── migrations/             # Database schema, RLS, indexes — apply in order
│   ├── 001_initial_schema.sql
│   ├── 002_rls_policies.sql
│   └── ...
└── functions/              # Edge functions (Deno/TypeScript)
    ├── claim-person/
    ├── generate-join-token/
    ├── join-trip/
    └── upgrade-guest-account/
```

---

## Status

This is the first public release. The sync protocol is stable but the deployment story is still being polished — feedback welcome via issues.

A hosted sync service (subscription) is planned for the future for users who don't want to self-host. Until then, this repository is the only way to use PackGuide's collaboration features.

---

## License

See `LICENSE`. The PackGuide app itself lives at https://github.com/tvyzqx/PackGuide.

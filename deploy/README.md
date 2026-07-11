# packalong.org — Deployment

Server-side config for the public brand domain `packalong.org` on the
HestiaCP host (`server.7-tm.de`, nginx front + Apache backend). One domain
serves three roles, split by path in the nginx template:

| Path | Handled by |
|---|---|
| `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` | local static (app association) |
| `/claim/*`, `/trip/*`, `/share/*` | local `deeplink.html` (fallback when app not installed) |
| everything else (`/`) | explainer at `t-velope.cc/packalong` |

Sync runs on the same box via a separate public subdomain
`sync.packalong.org` that proxies to Kong (`127.0.0.1:8000`), so the private
host `api.7-tm.de` no longer needs to appear in public share links.

---

## Already done (sync side, live)

- Edge functions redeployed to `/opt/supabase/volumes/functions/pa-*`
  (no more `packalong.app` references).
- `/opt/supabase/.env`: `PUBLIC_APP_HOST=packalong.org` — `functions` recreated.
- `/opt/supabase/.env`: `ADDITIONAL_REDIRECT_URLS` now includes
  `packalong://circle`, `https://packalong.org/claim/*`,
  `https://www.packalong.org/claim/*` — `auth` recreated.

## Prerequisites (blockers before go-live)

1. **DNS** — add to Cloudflare (proxied/orange, like `t-velope.cc`), origin `188.194.136.17`:
   - `packalong.org`        A → 188.194.136.17
   - `www.packalong.org`    A → 188.194.136.17  (or CNAME packalong.org)
   - `sync.packalong.org`   A → 188.194.136.17
2. **App identifiers** — fill the placeholders:
   - `web/.well-known/apple-app-site-association`: `REPLACE_TEAMID.REPLACE_BUNDLE_ID`
   - `web/.well-known/assetlinks.json`: `REPLACE_ANDROID_PACKAGE`, `REPLACE_SIGNING_SHA256_UPPER_COLON_SEPARATED`
   - `web/deeplink.html`: `REPLACE_APP_STORE_URL`, `REPLACE_PLAY_STORE_URL`

## Go-live steps (run once DNS resolves + placeholders filled)

```bash
# 1. Install the custom web template (main domain)
cp deploy/hestia/packalong.tpl  /usr/local/hestia/data/templates/web/nginx/
cp deploy/hestia/packalong.stpl /usr/local/hestia/data/templates/web/nginx/

# 2. Main domain: packalong.org (+ www alias), custom template
v-add-web-domain    ttimm packalong.org 188.194.136.17
v-add-web-domain-alias ttimm packalong.org www.packalong.org
v-change-web-domain-tpl ttimm packalong.org packalong
v-add-letsencrypt-domain ttimm packalong.org www.packalong.org   # Cloudflare grey-cloud during issuance if HTTP-01 fails

# 3. Publish the web content into the docroot
DOC=/home/ttimm/web/packalong.org/public_html
mkdir -p "$DOC/.well-known"
cp deploy/web/.well-known/apple-app-site-association "$DOC/.well-known/"
cp deploy/web/.well-known/assetlinks.json            "$DOC/.well-known/"
cp deploy/web/deeplink.html                          "$DOC/"
chown -R ttimm:www-data "$DOC"

# 4. Sync facade: sync.packalong.org -> Kong (reuse the existing supabase-api proxy)
v-add-web-domain ttimm sync.packalong.org 188.194.136.17
v-change-web-domain-proxy-tpl ttimm sync.packalong.org supabase-api ''
v-add-letsencrypt-domain ttimm sync.packalong.org

v-rebuild-web-domains ttimm
```

## Verify

```bash
curl -sI https://packalong.org/.well-known/apple-app-site-association | grep -i content-type   # application/json
curl -s  https://packalong.org/.well-known/assetlinks.json | head
curl -sI https://packalong.org/claim/TESTTOKEN | head -n1                                       # 200, serves deeplink.html
curl -s  https://sync.packalong.org/auth/v1/health -H "apikey: <ANON_KEY>"                       # {"...":true}
curl -s  https://packalong.org/ -I | head -n1                                                    # 200 (proxy) — explainer
```

## App side (other repo, PackAlong app)

The app must declare the domain so the OS verifies the links:
- iOS: Associated Domains → `applinks:packalong.org`
- Android: intent-filter `android:autoVerify="true"` for `https://packalong.org/{claim,trip,share}/*`
The `appID` / package / signing SHA-256 used above must match this build.

## Optional / later

- Point guest share links at the public facade instead of the private host:
  set `SUPABASE_PUBLIC_URL=https://sync.packalong.org` in `/opt/supabase/.env`
  and recreate `functions`. Then `api.7-tm.de` stays fully private.
- Root landing: template ships with **Option A** (masked proxy, keeps
  `packalong.org` in the URL). To switch to a plain 301 redirect
  (`t-velope.cc/en/packalong`), see the comment block in `packalong.stpl`.

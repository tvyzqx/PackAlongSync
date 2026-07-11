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

## Prerequisites

1. **DNS** — DONE. Cloudflare wildcard `*.packalong.org` + root, proxied
   (orange), NS `adele/plato.ns.cloudflare.com`. Covers www + sync.
2. **iOS app** — DONE. appID `DFM464QS5A.app.tvelope.packalong`,
   App Store `https://apps.apple.com/app/id6767585993`. (Android not
   published yet → assetlinks.json deferred, see note below.)
3. **TLS: Cloudflare Origin Certificate** — this host uses CF Origin certs,
   NOT Let's Encrypt (`LETSENCRYPT=no`, like t-velope.cc / api.7-tm.de).
   In Cloudflare: SSL/TLS → Origin Server → Create Certificate, hostnames
   `packalong.org, *.packalong.org`. One wildcard cert covers both the main
   domain and sync. Save the cert PEM + private key on the box, e.g.
   `/tmp/pa-origin.crt` and `/tmp/pa-origin.key`.

## Go-live steps

Uses Hestia internal IP `192.168.177.177` (same binding as the other
CF-proxied domains — NOT the public 188.194.136.17).

```bash
# 1. Install the custom web template (main domain)
cp deploy/hestia/packalong.tpl  /usr/local/hestia/data/templates/web/nginx/
cp deploy/hestia/packalong.stpl /usr/local/hestia/data/templates/web/nginx/

# 2. Main domain: packalong.org (+ www alias), custom template, SSL on
v-add-web-domain       ttimm packalong.org 192.168.177.177
v-add-web-domain-alias ttimm packalong.org www.packalong.org
v-change-web-domain-tpl ttimm packalong.org packalong
v-add-web-domain-ssl   ttimm packalong.org /tmp/pa-ssl-main   # dir with packalong.org.crt/.key/.ca

# 3. Publish the web content into the docroot
DOC=/home/ttimm/web/packalong.org/public_html
mkdir -p "$DOC/.well-known"
cp deploy/web/.well-known/apple-app-site-association "$DOC/.well-known/"
cp deploy/web/deeplink.html                          "$DOC/"
# assetlinks.json: skip until the Android app is published (fill placeholders first)
chown -R ttimm:www-data "$DOC"

# 4. Sync facade: sync.packalong.org -> Kong (reuse the existing supabase-api proxy)
v-add-web-domain ttimm sync.packalong.org 192.168.177.177
v-change-web-domain-proxy-tpl ttimm sync.packalong.org supabase-api ''
v-add-web-domain-ssl ttimm sync.packalong.org /tmp/pa-ssl-sync   # same wildcard cert, named sync.packalong.org.*

v-rebuild-web-domains ttimm
```

Hestia's `v-add-web-domain-ssl` expects a directory containing
`<domain>.crt`, `<domain>.key` (and optional `<domain>.ca`). The same
wildcard Origin cert/key is used for both, just named per domain.

## Verify

```bash
curl -sI https://packalong.org/.well-known/apple-app-site-association | grep -i content-type   # application/json
curl -sI https://packalong.org/claim/TESTTOKEN | head -n1                                       # 200, serves deeplink.html
curl -s  https://sync.packalong.org/auth/v1/health -H "apikey: <ANON_KEY>"                       # {"...":true}
curl -sI https://packalong.org/ | head -n1                                                       # 301 -> t-velope.cc/en/packalong
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
- Root landing: template ships with a **301 redirect** to
  `t-velope.cc/en/packalong` (chosen). Long-term plan is a dedicated
  packalong.org landing built in the Astro repo; swap the `location /`
  block in `packalong.stpl` for that origin when it exists. A masked-proxy
  alternative (keeps the URL) is documented as a comment in the same file.

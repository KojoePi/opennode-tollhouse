# Opennode Tollhouse

**A tiny, dependency-free web + sandboxed-worker framework for selling pay-per-use processing for Bitcoin Lightning, with no accounts.**
![Frontpage](https://github.com/KojoePi/tollhouse/blob/main/tollhouse-.jpg)
Build a service where people paste something in, pick outputs, pay a few cents in sats, and download the result. No sign-up, no email, no card, no tracking. Tollhouse gives you everything around your idea (wallet, payments, job queue, refunds, sandboxed execution, privacy defaults) so you only write the one function that does the actual work.

The demo product shipped in this repo takes a piece of text and returns `stats` (JSON) and `text` (cleaned). Replace it with anything: web scraping, PDF rendering, image or audio conversion, transcription, OCR, an ML model, an API wrapper.

## What you get

- **Anonymous wallet.** A session cookie is the account. Balance is kept as an append-only ledger in milli-credits (1 credit = 1 euro cent = 1000 milli, so half-cent prices work). Database triggers make ledger rows immutable, and `UNIQUE(type, ref_type, ref_id)` makes every charge, refund and top-up idempotent.
- **Lightning top-ups** through OpenNode: webhook plus server-side re-check, tiered bonus, min/max amounts. A fake checkout exists for local development and is honoured only when `DOMAIN=localhost`.
- **Recovery key** (`RLY-XXXX-XXXX-XXXX-XXXX-XXXX`). Shown once, stored only as an HMAC. Logging in with it on another device merges the guest balance into the key wallet.
- **Job queue** in SQLite with leases, retries, per-output pricing and **per-output refunds**: if one of three outputs fails, exactly that one is refunded. Lost workers are detected by lease expiry.
- **Sandboxed worker.** The worker container has no secrets, no volume, no inbound traffic, dropped capabilities, and an iptables egress firewall that allows only the web container and the public internet (private ranges, cloud metadata and other containers are rejected). It talks to web over a small token-protected internal API.
- **Privacy by default.** Inputs and results are deleted after 24 hours (configurable), the ledger keeps only a short label (never the input), labels themselves are purged after 30 days, and there are no third-party scripts or fonts.
- **Hardening.** Strict CSP, CSRF header plus Origin check, rate limits per IP and per session, `/internal/*` answers 404 to anything but the worker and is never reachable through the proxy, SSRF helpers in `src/security.js` for products that fetch URLs.
- **Frontend.** Vanilla ES modules, German and English, QR codes for invoices, history, key backup file. No build step.
- **Legal page slots.** `impressum.html`, `datenschutz.html` and `agb.html` are static files with `{{LEGAL_NAME}}`-style placeholders filled (and HTML-escaped) from `.env`. The repo contains **no legal text**: write your own, this is your responsibility.
- **Zero npm dependencies.** Node 22 and its built-in `node:sqlite`. Nothing to audit, nothing to update.

## Architecture

```
            Internet
               |  HTTPS
        +------v------+      one shared proxy per server
        |  edge Caddy |      (repo: relayted-edge)
        +------+------+
               | network "relayted_edge"  (web containers only)
        +------v------+   project-internal net   +-----------------+
        |     web     | <----------------------- |     worker      |
        | API, UI,    |   WORKER_TOKEN, /internal| no secrets,     |
        | wallet, DB  |                          | egress firewall |
        +-------------+                          +-----------------+
```

Several projects can live on one server and share one Caddy and one certificate store. The edge proxy has its own repository: `relayted-edge`. See `README.ai.md` for the exact wiring rules.

## Quick start (local)

Requires Node 22.13 or newer.

```
npm test                       # unit + end-to-end tests, no network needed
DOMAIN=localhost OPENNODE_MOCK=true \
KEY_PEPPER=dev-pepper-dev-pepper-dev WORKER_TOKEN=dev-token-dev-token-dev-token-dev-tok \
node src/server.js             # http://localhost:3000
```

Start the worker in a second terminal with `WEB_URL=http://localhost:3000 WORKER_TOKEN=... node worker/worker.js`. Top up with the fake checkout, submit some text, watch the job complete.

## Deploy (Ubuntu server with Docker)

1. Set up the edge proxy once per server (see the edge repository).
2. Point a DNS A record for your domain to the server and add a block for it to the edge `Caddyfile` (upstream `newproject-web:3000`).
3. Clone this repo to `/opt/relayted-newproject`, then `sudo make install`. It installs Docker if needed, creates the shared network, generates secrets, writes `.env` (mode 600), builds and starts web + worker.
4. **Back up `.env`.** `KEY_PEPPER` must never change after go-live or every recovery key stops working.
5. `make doctor` verifies that the worker firewall blocks private and metadata addresses.

Useful targets: `make update` (rebuild, and restarts the worker, which is required because its firewall pins web's IP), `make logs`, `make status`, `make test`, `make uninstall [PURGE=1]`.

## Make it your product

Only a handful of files are product-specific:

| File | What to change |
|---|---|
| `worker/pipeline.js` | The actual work. One job in, one result or failure code per requested output out. |
| `src/product/pricing.js` | Output names, file types, and `PRICING_<OUTPUT>_CENTS` in `.env`. |
| `src/product/input.js` | Validate and label the user's input before anything is charged. |
| `public/index.html`, `public/i18n.js`, `public/app.js` | Copy, form fields, output cards. |
| `worker/Dockerfile` | Add what your engine needs (ffmpeg, Chromium via Playwright, Python, ...). Raise `mem_limit` in `docker-compose.yml` accordingly. |

Everything under `src/platform/`, the wallet, identity, payments, rate limiting and the queue, should not need changes. Name, cookie and key prefix are configurable (`PROJECT_NAME`, `COOKIE_NAME`, `KEY_PREFIX`).

Contract for the worker: call `deliver(output, buffer)` as soon as an output exists, `fail(output, code)` for anything that cannot be delivered, and never leave an output pending. The failure `code` is shown to the user through the i18n key `fail.<code>`. A failed output is refunded automatically.

## Legal pages

Edit `public/impressum.html`, `public/datenschutz.html` and `public/agb.html` and keep the placeholders you need: `{{LEGAL_NAME}}`, `{{LEGAL_ADDRESS}}`, `{{LEGAL_EMAIL}}`, `{{LEGAL_VAT_ID}}`, `{{DOMAIN}}`, `{{BASE_URL}}`. Values come from `.env` and are escaped on output, so they cannot inject markup. The shipped files are empty stubs with TODO markers. What you must publish depends on your jurisdiction and your product, and this project provides no legal advice.

## Security model in short

Web holds every secret and is the only component reachable from outside. The worker is treated as untrusted: if a malicious input owns it, it still has no secrets, no disk to read, and no network path to anything internal. It can only request jobs and post results to web, which validates sizes, ownership and state before accepting anything. Money moves only inside web, in a single transaction together with the job row, so there is no state where a user is charged without a queued job.

Report vulnerabilities privately to the maintainer of your fork. Do not open public issues for them.

## License

MIT. See `LICENSE`.

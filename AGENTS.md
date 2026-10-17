# CLAUDE.md — Urumi MCP Gateway

Project context and rules for coding agents (Claude Code reads this file; copy it to AGENTS.md for Cursor).

## Who you're working with

I'm building this for a job interview (Urumi AI FDE internship, Round 1). I will have to walk through
every part of it live and defend my choices. So:

- **Small steps.** Do only the phase or sub-step I name. Don't jump ahead or "also add" features.
- **No magic.** Prefer simple, readable code over clever abstractions. No extra frameworks unless I agree.
- **Never** commit secrets, run `git push --force`, delete PVCs/namespaces, or drop database tables
  without asking me first.
- When something fails, ask me for `kubectl describe`, `kubectl logs`, or `kubectl get events` output
  instead of guessing.

## What we're building

A WooCommerce hosting platform with a team MCP gateway, all on Kubernetes, deployed with Helm.

1. **Store** — WordPress + WooCommerce + MariaDB, persistent storage, public storefront.
2. **mcp-woo** — our own MCP server (Streamable HTTP) exposing store products and orders as tools.
   Internal only.
3. **Gateway + dashboard** — admins register MCP servers; the gateway is an MCP client to every upstream
   and an MCP server to users, exposing all tools at one `/mcp` endpoint with per-user API keys and an
   audit log. React dashboard.
4. **Chat agent** — in the dashboard; an LLM tool loop that calls tools through the gateway as the
   logged-in user.

Rule: nothing except the gateway talks to upstream MCP servers. The chat agent and external clients
both go through `/mcp`.

## Stack (do not change without asking)

| Piece         | Choice                                                                               |
| ------------- | ------------------------------------------------------------------------------------ |
| Local cluster | k3d (k3s in Docker), Traefik ingress                                                 |
| Production    | k3s on a VPS, same charts, `values-prod.yaml`                                        |
| Packaging     | Helm only (no Kustomize). One umbrella chart `charts/platform` with subcharts        |
| Language      | TypeScript everywhere, Node 20                                                       |
| MCP           | `@modelcontextprotocol/sdk`, Streamable HTTP, **stateless mode**                     |
| Gateway       | Express, Postgres, Drizzle ORM (migrations run on startup)                           |
| Dashboard     | React + Vite + TypeScript, served by nginx (non-root)                                |
| LLM           | `openai` SDK with configurable `baseURL` (Gemini or Groq OpenAI-compatible endpoint) |
| Local domains | `shop.127.0.0.1.nip.io`, `app.127.0.0.1.nip.io`                                      |

## Repo layout

```
CLAUDE.md  AGENTS.md  README.md  Makefile
docs/        design.md  threat-model.md  notes.md
services/    mcp-woo/  mcp-notes/  gateway/  dashboard/
charts/platform/
  charts/    store/ mcp-woo/ mcp-notes/ mcp-everything/ gateway/ dashboard/ postgres/
  values.yaml  values-local.yaml  values-prod.yaml  secrets.example.yaml
```

- Everything runs in namespace `urumi`.
- `secrets.local.yaml` / `secrets.prod.yaml` hold real values and are **gitignored**.
  `secrets.example.yaml` is the committed template.
- Makefile targets: `build`, `import` (k3d image import), `deploy` (helm upgrade --install with local
  values + secrets), `logs`, `reset`.

## Kubernetes rules (apply to every workload)

- Readiness and liveness probes.
- Resource requests and limits.
- Containers run as non-root where the image allows it.
- All credentials come from Kubernetes Secrets via env or mounted files. Nothing secret in source,
  values files that are committed, or images.
- Stateful things (MariaDB, WordPress files, Postgres) use PVCs.
- Default-deny NetworkPolicy for the namespace, then explicit allows:
  - Traefik → WordPress, dashboard, gateway
  - gateway → every MCP server, Postgres
  - mcp-woo → WordPress
  - WordPress → MariaDB
- MCP servers: ClusterIP Service only, **no Ingress**.
- Every Deployment has labels `app: <name>`; NetworkPolicies select on those.
- Local vs prod differences live **only** in values files: domains, TLS/cert-manager, image repo/tag,
  storage class, resource sizes, replica counts.

## Store (Phase 1)

- MariaDB: StatefulSet + PVC via `volumeClaimTemplates`, headless Service.
- WordPress: Deployment + PVC for `/var/www/html`, Service, Ingress `shop.<domain>`.
- Setup Job (Helm post-install/post-upgrade hook, `wordpress:cli` image), **idempotent**:
  1. wait for DB
  2. `wp core install` (skip if installed); keep `siteurl`/`home` in sync with values
  3. install + activate WooCommerce; pretty permalinks
  4. timezone `Asia/Kolkata`
  5. enable Cash on Delivery; create 3 sample products if none exist
  6. create API user + application password; a second container (kubectl image) writes it to Secret
     `woo-api`. The Job's ServiceAccount may only create/patch that one Secret (least-privilege RBAC).
- Gotcha: WordPress disables application passwords over plain HTTP. Ship a must-use plugin that enables
  them (in-cluster traffic is HTTP).

## mcp-woo (Phase 2)

- `POST /mcp` (Streamable HTTP, stateless), `GET /healthz`.
- Talks to the WooCommerce REST API (`/wp-json/wc/v3`) at the in-cluster WordPress Service URL using
  basic auth with the application password from Secret `woo-api`. Reason: official, validated, versioned,
  no shell access to WordPress needed.
- Tools (zod schemas, clear descriptions):

| Tool                  | Inputs                                    | Calls                           |
| --------------------- | ----------------------------------------- | ------------------------------- |
| `list_products`       | search?, per_page?                        | GET /products                   |
| `create_product`      | name, regular_price, description?         | POST /products (status publish) |
| `list_orders`         | after? (ISO date), status?, per_page?     | GET /orders                     |
| `get_order`           | id                                        | GET /orders/{id}                |
| `update_order_status` | id, status (enum of WooCommerce statuses) | PUT /orders/{id}                |

- Return trimmed JSON (id, name, price, status, total, date, customer name, line items), not raw payloads.
- Errors → `isError: true` with a readable message.

## Gateway (Phase 3)

### Data model

| Table      | Columns                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| users      | id, email, password_hash, role (admin/member), created_at                                                                            |
| invites    | id, email, role, token_hash, expires_at, used_at                                                                                     |
| api_keys   | id, user_id, prefix, key_hash, created_at, revoked_at, last_used_at                                                                  |
| servers    | id, slug, name, url, auth_type (none/bearer/header), header_name, credential_encrypted, enabled, status, last_error, last_checked_at |
| audit_logs | id, user_id, source (chat/mcp), server_slug, tool, started_at, duration_ms, outcome (success/error/rejected), error_message          |

### Auth

- Dashboard: email + password (argon2), httpOnly session cookie. First admin seeded from a Secret.
- Invites: admin creates a one-time link; member sets a password.
- API keys: `urk_` + 32 random bytes, shown once, stored as SHA-256 hash + short visible prefix.
- Roles enforced server-side on every admin route.

### Upstream manager

- One MCP client (`StreamableHTTPClientTransport`) per enabled server; upstream credential added as a
  header **only here**.
- Cache tool lists. Health check every 15 s, 5 s timeout → status Connected / Unreachable, store
  `last_error`. Disabled servers are not contacted.
- Credentials encrypted at rest with AES-256-GCM; key from a Secret.
- Seed `mcp-woo` as the first registered server on startup if absent.

### `/mcp` endpoint

- Auth: `Authorization: Bearer urk_…` (or short-lived chat JWT, see Phase 5) → user. Missing/revoked →
  401 and an audit row with outcome `rejected`.
- `tools/list`: merge cached tools of enabled + connected servers. Use `Promise.allSettled`; one bad
  upstream never breaks the list.
- **Collision scheme:** exposed name = `<slug>__<tool>` (e.g. `woo__list_orders`), description prefixed
  `[<slug>]`. Slugs are unique, `[a-z0-9_]`, full name ≤ 64 chars.
- `tools/call`: split prefix → check server exists and is enabled → forward with 20 s timeout →
  map failures to `isError` with a clear message (`Upstream 'notes' unreachable: timed out after 20s`).
- Write an audit row for **every** call.
- User tokens are **never** forwarded upstream.

### Admin API

`/api/servers` (CRUD, enable/disable — responses never include credentials, only `hasCredential`),
`/api/members`, `/api/invites`, `/api/keys`, `/api/audit` (filters: user, server, outcome).
Optional: SSRF guard on server URLs (block private, link-local, metadata IPs; allowlist in-cluster
service names).

### Extra upstreams

- `mcp-notes` (ours, small): `add_note`, `list_notes`, `echo`. Requires a bearer token (from a Secret)
  so we can show upstream credentials in action.
- `mcp-everything`: official MCP reference server in Streamable HTTP mode. Its `echo` collides with
  notes' `echo` on purpose.

## Dashboard (Phase 4)

Pages: Login / accept invite · Servers (status badge, last error, tool list, add/edit/enable/disable/
delete) · Members (admin) · API keys (generate shown once + copyable `claude mcp add` command, revoke) ·
Audit log (filters, auto-refresh) · Chat.
Ingress `app.<domain>`: `/api` and `/mcp` → gateway, `/` → dashboard.
The browser never receives an upstream credential.

## Chat agent (Phase 5)

- `POST /api/chat` (session auth) mints a 5-minute signed JWT for the logged-in user and connects to the
  gateway's own `/mcp` as an MCP client. Same auth, routing and audit path as external clients;
  audit `source = chat`.
- Loop (max 8 rounds): tools/list → LLM → tool calls via tools/call → results back → until text answer.
- System prompt includes today's date and timezone.
- Response returns the answer + list of tool calls (name, args, duration, ok/error) for the UI.
- LLM API key from a Secret; provider, model, baseURL from values.

## Definition of done (must pass before recording)

1. Storefront checkout with COD; order visible in WooCommerce admin.
2. User A in chat: create product → on storefront; hand-placed order → "orders today" returns it.
3. User B: Claude Code/Cursor/MCP Inspector with only gateway URL + key; sees all enabled servers' tools;
   orders question works; one prompt uses two servers.
4. Revoke B's key → rejected. Disable a server → tools gone from chat and client. Kill an MCP pod →
   others work, dashboard shows Unreachable.
5. Every call above in the audit log under the right user.

## Docs to keep current

- `docs/notes.md` — my learning log (I write it).
- `docs/design.md` — architecture, aggregation/routing/failure handling, local vs prod.
- `docs/threat-model.md` — I write this myself; help only by asking me questions.
- `README.md` — local setup, VPS setup, place an order, connect an MCP client, use the chat.

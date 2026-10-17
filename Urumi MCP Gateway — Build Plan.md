# Urumi MCP Gateway — Build Plan

Oct 17, 2026 · @Mounterra Innovations

Build in 8 phases over 14 days, one phase per agent session, and do not start a phase until the previous one passes its check. The agent writes most of the code; you must be able to defend every line in the interview.

## How to work with the coding agent

1. **CLAUDE.md lives in the repo root.** It holds the architecture, stack and rules. Claude Code reads it every session; for Cursor, copy it to `AGENTS.md` too.
2. **One phase per session.** Open each session with: `Read CLAUDE.md. We are on Phase N: <name>. Explain your plan and the files you'll create before writing any code.`
3. **Plan first, then code.** Use plan mode. If the plan has something you don't understand, ask before approving.
4. **Read every diff.** For anything unclear, ask: `Explain this file like I'll be asked about it in an interview.`
5. **Paste real errors, don't guess.** Give the agent the output of `kubectl describe pod`, `kubectl logs` and `kubectl get events`.
6. **Commit at the end of every phase** with a clear message. Never let the agent run `git push --force` or delete data.
7. **Keep a learning log.** After each phase, write 5 lines in `docs/notes.md`: what you built, one decision and why, one thing that broke. This becomes your README, design note and interview answers.
8. **End every phase with a quiz:** `Quiz me with 5 interview questions on what we built in this phase. Don't give answers until I try.`

## Stack and repo layout

Use one language (TypeScript) for every service and k3d locally, because k3d is k3s in Docker and the VPS runs k3s too. Same ingress, same storage class, same NetworkPolicy behaviour in both places.

| Piece | Choice | Why |
| --- | --- | --- |
| Local cluster | k3d | Same as the VPS (k3s); ships Traefik ingress; enforces NetworkPolicies (kind does not by default) |
| Production | k3s on a VPS | Same Helm charts, different values file |
| Store | Official `wordpress` + `mariadb` images | Own chart, so you understand every resource |
| MCP servers | TypeScript + `@modelcontextprotocol/sdk` | Most mature SDK, Streamable HTTP built in |
| Gateway backend | Node + Express + TypeScript, Postgres, Drizzle ORM | Simple, readable migrations |
| Dashboard | React + Vite + TypeScript, shadcn/ui or Mantine | Prebuilt components save days |
| Chat LLM | Gemini free tier or Groq, via the `openai` SDK with a custom `baseURL` | Provider becomes a config value |
| Local domains | `*.127.0.0.1.nip.io` | Resolves to localhost everywhere, including Claude Code and curl; no /etc/hosts edits |

Repo layout:

```
urumi-mcp-gateway/
  CLAUDE.md  AGENTS.md  README.md
  docs/         design.md  threat-model.md  notes.md
  services/
    mcp-woo/      # WooCommerce MCP server
    mcp-notes/    # tiny second MCP server you write
    gateway/      # backend: auth, upstreams, /mcp, /api, chat
    dashboard/    # React app
  charts/
    platform/     # umbrella chart, one helm install deploys everything
      charts/     # subcharts: store, mcp-woo, mcp-notes, mcp-everything, gateway, dashboard, postgres
      values.yaml
      values-local.yaml
      values-prod.yaml
      secrets.example.yaml   # committed template; real secrets file is gitignored
  Makefile      # build images, import to k3d, helm upgrade
```

Everything runs in one namespace (`urumi`). Isolation comes from NetworkPolicies on pod labels, which is simpler to explain than cross-namespace rules.

&#91;embedded content: architecture · what's public, what's internal\]

Only the storefront and the dashboard/gateway host are public. MCP servers never see a user's key; the gateway adds each upstream's credential itself.

## Phase 0: Setup (day 1, half day)

Goal: a hello-world page served from your cluster through Ingress and Helm.

1. Install Docker, k3d, kubectl, Helm, Node 20+, and Claude Code or Cursor.
2. Create the cluster with port 80 mapped to Traefik: `k3d cluster create urumi -p "80:80@loadbalancer" --agents 1`
3. Create the repo, add `CLAUDE.md`, and create the empty folders from the layout above.
4. Have the agent make a tiny Helm chart (nginx Deployment, Service, Ingress at `hello.127.0.0.1.nip.io`) and install it.
5. Write a `Makefile` with targets: `build` (docker build all services), `import` (`k3d image import`), `deploy` (`helm upgrade --install` with values-local).

**Agent prompt:** `Phase 0. Create a minimal Helm chart that serves nginx at hello.127.0.0.1.nip.io through Traefik on k3d. Then a Makefile with build, import and deploy targets. Explain each Kubernetes object you create.`

**Done when:**

- [ ] `http://hello.127.0.0.1.nip.io` opens in the browser
- [ ] You can explain how the request goes browser → Traefik → Ingress → Service → Pod
- [ ] `helm upgrade` and `helm rollback` work on this chart

## Phase 1: Store on Kubernetes (days 1–3)

Goal: a working WooCommerce store at `shop.127.0.0.1.nip.io` whose data survives pod restarts, set up with zero manual clicks.

1. **MariaDB:** StatefulSet with a PVC (`volumeClaimTemplates`), headless Service, passwords from a Secret.
2. **WordPress:** Deployment, PVC for `/var/www/html`, ClusterIP Service, Ingress at `shop.127.0.0.1.nip.io`. DB credentials come from the same Secret.
3. **Setup Job** (Helm `post-install` hook, `wordpress:cli` image) that is safe to re-run:
   - wait for the DB, then `wp core install` with the shop URL
   - install and activate WooCommerce, set pretty permalinks
   - set the store timezone to `Asia/Kolkata` (otherwise "today's orders" breaks)
   - enable Cash on Delivery, create 3 sample products
   - create an API user with an **application password** for the MCP server
4. **Get that password into a Secret.** The Job writes it to a shared volume, and a second container with `kubectl` creates the `woo-api` Secret. Give the Job a ServiceAccount that can only create that one Secret (least-privilege RBAC is an interview point).
5. **Probes and limits** on both workloads from day one.
6. **Secrets:** real values go in `secrets.local.yaml` (gitignored); charts read them through `existingSecret`-style references.

**Known gotchas** (tell the agent upfront):

- WordPress disables application passwords over plain HTTP. Add a small must-use plugin that enables them, since in-cluster traffic is HTTP.
- WordPress stores the site URL in the DB. If the domain changes (local → VPS), it must be updated too; the Job should handle that.

**Agent prompt:** `Phase 1. Build the store subchart: MariaDB StatefulSet with PVC, WordPress Deployment with PVC, Ingress, Secrets, probes, limits, and an idempotent setup Job using wp-cli (see CLAUDE.md for the exact steps). Explain each resource and why the DB is a StatefulSet.`

**Done when:**

- [ ] Storefront opens; you add a product to the cart and check out with COD
- [ ] The order shows in WooCommerce admin
- [ ] Deleting the WordPress and MariaDB pods loses nothing
- [ ] The `woo-api` Secret exists and nothing secret is in git
- [ ] You can explain PV vs PVC, StatefulSet vs Deployment, and how a Secret reaches a pod

## Phase 2: WooCommerce MCP server (days 3–5)

Goal: your own MCP server, reachable only from inside the cluster, that can read and change the store.

1. **Server:** `services/mcp-woo`, Express + `@modelcontextprotocol/sdk`, Streamable HTTP at `POST /mcp`, plus `GET /healthz`. Use **stateless mode** (no session IDs): simpler, and it scales to multiple replicas for free.
2. **Five tools**, each with a zod input schema and a clear description:

| Tool | Inputs | WooCommerce call |
| --- | --- | --- |
| `list_products` | search?, per\_page? | `GET /wc/v3/products` |
| `create_product` | name, regular\_price, description? | `POST /wc/v3/products` (status publish) |
| `list_orders` | after? (ISO date), status?, per\_page? | `GET /wc/v3/orders` |
| `get_order` | id | `GET /wc/v3/orders/{id}` |
| `update_order_status` | id, status (enum) | `PUT /wc/v3/orders/{id}` |

3. **Talking to the store:** the WooCommerce REST API at the in-cluster Service URL, with basic auth using the application password from the `woo-api` Secret. Write in `docs/notes.md` why: official, validated, versioned, and needs no shell access into WordPress (WP-CLI would).
4. **Keep results small.** Return trimmed JSON (id, name, price, status, total, date, line items), not the full WooCommerce payload. Errors return `isError: true` with a readable message.
5. **Test locally first** with `kubectl port-forward` to WordPress and MCP Inspector.
6. **Deploy:** Dockerfile (non-root user), subchart with Deployment, ClusterIP Service, **no Ingress**, probes, limits, and a NetworkPolicy that only allows traffic from pods labelled `app: gateway`.

**Agent prompt:** `Phase 2. Build services/mcp-woo: a stateless Streamable HTTP MCP server with the 5 tools in CLAUDE.md, calling the WooCommerce REST API with credentials from env. Then its Dockerfile and subchart with a NetworkPolicy allowing only the gateway. Walk me through initialize, tools/list and tools/call as JSON-RPC messages.`

**Done when:**

- [ ] MCP Inspector (via port-forward) lists 5 tools and each works
- [ ] `create_product` makes a product that appears on the storefront
- [ ] `list_orders` with today's date returns your Phase 1 order
- [ ] A curl from a throwaway pod without the gateway label times out (NetworkPolicy works)
- [ ] You can draw the JSON-RPC flow on paper

## Phase 3: Gateway backend (days 5–9)

Goal: one `/mcp` endpoint that authenticates a user's API key, merges tools from every enabled upstream, routes calls, survives dead upstreams, and logs everything. Build it in six sessions, 3a to 3f.

### 3a. Skeleton and database

Express + TypeScript, Postgres as its own StatefulSet with a PVC, Drizzle migrations run on startup.

| Table | Key columns |
| --- | --- |
| `users` | id, email, password\_hash, role (admin / member), created\_at |
| `invites` | id, email, role, token\_hash, expires\_at, used\_at |
| `api_keys` | id, user\_id, prefix, key\_hash, created\_at, revoked\_at, last\_used\_at |
| `servers` | id, slug, name, url, auth\_type (none / bearer / header), header\_name, credential\_encrypted, enabled, status, last\_error, last\_checked\_at |
| `audit_logs` | id, user\_id, source (chat / mcp), server\_slug, tool, started\_at, duration\_ms, outcome (success / error / rejected), error\_message |

### 3b. Auth

- **Dashboard login:** email + password (argon2 or bcrypt), httpOnly session cookie. First admin is seeded from a Secret on startup.
- **Invites:** admin enters an email and gets a one-time link; the member sets a password.
- **API keys:** `urk_` + 32 random bytes, shown once, stored as a SHA-256 hash with a short visible prefix. A fast hash is fine here because the key is long and random (be ready to explain why passwords need argon2 but keys don't).
- **Role middleware** on every admin route, enforced server-side.

### 3c. Upstream manager

- For each enabled server, keep an MCP client (`StreamableHTTPClientTransport`) with the credential added as a header **only here, server-side**.
- Cache each server's tool list. A health loop every 15 s with a 5 s timeout sets status to Connected or Unreachable and records `last_error`. Disabled servers are not contacted.
- Credentials are encrypted at rest with AES-256-GCM; the key comes from a Secret.
- On startup, seed the WooCommerce server as the first registered server if it isn't there.

### 3d. The `/mcp` endpoint

- **Auth:** `Authorization: Bearer urk_…` → hash → look up → reject if missing or revoked (and log it as `rejected`).
- **`tools/list`:** merge cached tools from enabled, connected servers. Name each `<slug>__<tool>` (e.g. `woo__list_orders`) and prefix the description with `[slug]`. This is your collision scheme: slugs are unique, so names are too. Keep slugs to `[a-z0-9_]` and full names under 64 characters.
- **`tools/call`:** split the prefix, check the server is still enabled, forward with a 20 s timeout, return `isError` with a clear message on failure (e.g. `Upstream 'notes' unreachable: timed out after 20s`).
- **Audit every call**: user, source, server, tool, start, duration, outcome.
- Use stateless mode here too.

### 3e. Admin REST API for the dashboard

`/api/servers` (CRUD, enable/disable; never returns a credential, only `hasCredential: true`), `/api/members`, `/api/invites`, `/api/keys`, `/api/audit` (filters: user, server, outcome). Optional stand-out: block private, link-local and metadata IPs when an admin adds a URL (SSRF), with an allowlist for in-cluster services.

### 3f. Two more upstream servers

- **`mcp-notes`** (write it, \~50 lines): `add_note`, `list_notes`, and an `echo` tool on purpose.
- **`mcp-everything`**: the official reference server run in Streamable HTTP mode. It also has `echo`, so you get a real name collision to show in the demo.
- Each gets a subchart, probes, limits and a gateway-only NetworkPolicy. Give `mcp-notes` a bearer token so you can show an upstream credential being used without anyone seeing it.

**Agent prompt (per sub-step):** `Phase 3<x>. Read CLAUDE.md. Implement <sub-step> only. Show me the plan first. After coding, explain how a tool call flows through the code you just wrote.`

**Done when:**

- [ ] MCP Inspector connects to `http://app.127.0.0.1.nip.io/mcp` with only an API key and sees tools from all three servers
- [ ] `woo__list_orders` works through the gateway
- [ ] Both `echo` tools appear, prefixed differently
- [ ] Revoked key → next call rejected and logged
- [ ] Scaling `mcp-notes` to 0 → the other tools still list and work; status shows Unreachable within \~15 s
- [ ] No API response ever contains an upstream credential
- [ ] You can trace one call: client → Ingress → `/mcp` auth → router → upstream client → MCP server → WooCommerce → back

## Phase 4: Dashboard (days 8–10, overlaps Phase 3)

Goal: every admin and member user story is clickable. Keep it plain; nobody grades the styling.

- **Deploy:** React + Vite build served by an nginx container (non-root). One Ingress host `app.127.0.0.1.nip.io`: `/api` and `/mcp` → gateway, `/` → dashboard.
- **Pages:**

| Page | Who | What it does |
| --- | --- | --- |
| Login / accept invite | all | Sign in, or set a password from an invite link |
| Servers | admin edits, member views | Table with status badge (Connected / Unreachable / Disabled), last error, expandable tool list; add, edit, enable/disable, delete |
| Members | admin | Invite by email, change role, remove |
| API keys | all | Generate (shown once, with copy button and ready-made Claude Code command), list by prefix, revoke; admin can revoke anyone's |
| Audit log | admin (members see their own) | Who, server, tool, when, duration, outcome; filters; auto-refresh |
| Chat | all | Phase 5 |

- The browser never receives an upstream credential; the edit form shows "credential set" and a field to replace it.

**Agent prompt:** `Phase 4. Build the dashboard with the pages in CLAUDE.md against the existing /api routes. Use <component library>. Also the nginx Dockerfile and subchart with Ingress routing. Keep it simple and functional.`

**Done when:**

- [ ] Every admin and member user story from the assignment works by clicking
- [ ] Browser devtools Network tab shows no upstream credential in any response

## Phase 5: Chat agent (days 10–11)

Goal: a chat that answers with tools, shows which tools it called, and appears in the audit log as the logged-in user.

1. **The chat is just another MCP client of the gateway.** `POST /api/chat` (session cookie) mints a short-lived token (signed JWT, 5 min) for the logged-in user. It then connects to the gateway's own `/mcp` with that token, so it goes through the exact same auth, routing, permissions and audit path as Claude Code. Audit rows get `source = chat`. This is the cleanest answer to "how does the agent act as the user".
2. **The loop** (max 8 rounds):
   1. `tools/list` → convert each tool's `inputSchema` into the LLM's function format
   2. send history + tools to the LLM
   3. if it requests tool calls → run each via `tools/call` → append results → go to step 2
   4. if it answers in text → return the answer plus the list of tool calls (name, args, duration, ok/error)
3. **System prompt** includes today's date and the store timezone, so "today's orders" works.
4. **LLM:** the `openai` SDK pointed at Gemini's or Groq's OpenAI-compatible endpoint. Provider, model and base URL come from values; the API key from a Secret.
5. **UI:** message bubbles, plus a collapsible chip per tool call showing name, args and result.

**Agent prompt:** `Phase 5. Build the chat agent as described in CLAUDE.md: the backend mints a short-lived user token and acts as an MCP client to our own /mcp. Implement the tool loop with the openai SDK and a configurable baseURL. Then the chat page. Explain the loop step by step.`

**Done when:**

- [ ] "Create a product called Test Mug for ₹499" → it appears on the storefront
- [ ] Place an order by hand, then ask "what orders came in today?" → it returns that order
- [ ] The chat shows which tools were called
- [ ] Those calls appear in the audit log under your user with source `chat`
- [ ] You can explain the loop without notes

## Phase 6: Hardening, VPS and docs (days 11–12)

Goal: production-ready charts, one real VPS deploy, and the written deliverables.

**Hardening checklist**

- [ ] Every workload has readiness + liveness probes, requests + limits (ask the agent for a table of all of them; it's a demo slide)
- [ ] Containers run as non-root
- [ ] Default-deny NetworkPolicy in the namespace, then explicit allows (Traefik → WordPress/dashboard/gateway; gateway → MCP servers + Postgres; MCP servers → their targets)
- [ ] No secret in git: `git grep` for passwords and keys comes back clean

**What changes between local and VPS** (only through values):

| Setting | values-local.yaml | values-prod.yaml |
| --- | --- | --- |
| Domains | `shop.127.0.0.1.nip.io`, `app.127.0.0.1.nip.io` | real domain, or `shop.<VPS-IP>.nip.io` if no domain |
| TLS | off | cert-manager + Let's Encrypt |
| Images | local tags imported with `k3d image import` | GHCR (`ghcr.io/<user>/...`) with version tags |
| Storage class | `local-path` | `local-path` (k3s) or the cloud's class |
| Resources | small | slightly larger |
| Secrets | `secrets.local.yaml` (gitignored) | created on the server, never committed |

**VPS steps:** a 4 GB VPS (Hetzner, DigitalOcean, or Oracle free tier), install k3s, push images to GHCR, `helm upgrade --install` with values-prod, check from your laptop. This is the easiest stand-out item.

**Upgrade and rollback:** bump an image tag → `helm upgrade` → `helm history` → `helm rollback`. Do it once on camera.

**Docs**

- `README.md`: local setup, VPS setup, placing an order, connecting an MCP client, using the chat. Include: `claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <key>"` and a Cursor `mcp.json` example.
- `docs/design.md`: architecture, aggregation, routing, failure handling, local vs production.
- `docs/threat-model.md`: **write this yourself.** Answer the four questions in the assignment: shared upstream credentials, why client tokens aren't passed through, malicious tool descriptions, what one member can do to another.
- A short list of stand-out items attempted and where they live.

## Phase 7: Rehearse and record (days 13–14)

Goal: run the full definition of done twice without fixing anything, then record. Make two users first: User A (admin) in one browser, User B (member) in an incognito window.

**Definition-of-done run**

- [ ] Storefront: add to cart, COD checkout, order visible in WooCommerce admin
- [ ] User A, chat: create a product with name and price → visible on storefront
- [ ] Place an order for it by hand → User A asks chat "what orders came in today?" → returns it
- [ ] User B: generate key, connect Claude Code / Cursor / MCP Inspector with only gateway URL + key
- [ ] User B sees tools of every enabled server and asks the same orders question
- [ ] User B runs one prompt using two servers (e.g. "summarise today's orders and save it as a note")
- [ ] Revoke User B's key → next call rejected
- [ ] Disable one server → its tools disappear from chat and from the external client (reconnect the client if it caches the list)
- [ ] Delete one MCP server's pod → others keep working, dashboard shows it Unreachable
- [ ] Audit log shows every call above under the right user

**Demo video outline** (matches the six required sections):

1. System design: the architecture picture, then the live two-user run above
2. Kubernetes: `kubectl get all,pvc,secrets,ingress,networkpolicy`, the probes/limits table, what's public vs internal
3. MCP internals: one tool call traced through the code, collisions, timeouts, a dead upstream
4. Security: how keys and upstream credentials are stored, what a member can't do, a malicious upstream server
5. Chat agent: the loop and the short-lived user token
6. Local to VPS: the values diff, the VPS running, upgrade and rollback

**Mock interview:** ask the agent to `Act as a senior engineer interviewing me on this repo. Ask one hard question at a time about Kubernetes, MCP, security and my design choices. Push back on weak answers.` Then do one round with Gyan.

**Bonus:** only start multi-store provisioning if every box above is ticked by day 10.

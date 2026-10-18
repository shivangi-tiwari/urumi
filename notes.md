Phase 1 
-Built: MariaDB StatefulSet, WordPress Deployment, both on PVCs, and an idempotent setup Job.
-Decision and why: I pinned WooCommerce to 10.3.6 so upstream releases can’t break the deploy.
-Broke: the bitnami/kubectl tag vanished from Docker Hub, and the latest WooCommerce needed WordPress 7.0. I diagnosed both from kubectl describe and the Job logs.


## Phase 2: mcp-woo (18 Oct 2026)

### What I built
- An MCP server (TypeScript, Express, MCP SDK) in stateless Streamable HTTP mode, with `POST /mcp` and `GET /healthz`.
- Five tools: list_products, create_product, list_orders, get_order, update_order_status. They call the WooCommerce REST API using the application password from the `woo-api` Secret.
- A multi-stage Dockerfile (non-root `node` user) and a Helm subchart with a ClusterIP Service and no Ingress.

### Decisions and why
- Stateless mode: [your reason, e.g. every request is independent, so pods can scale and restart without session state].
- WooCommerce REST API instead of WP-CLI or direct DB access: [your reason, e.g. official, validated, versioned, no shell access needed].
- No Ingress for MCP servers: [your reason, e.g. only the gateway should reach upstreams].
- Return trimmed JSON, not raw payloads: [your reason].
- Errors return isError with a readable message that never includes credentials.

### What broke and how I fixed it
- WOO_BASE_URL gave a 404: the code appends /wp-json/wc/v3 itself, so the variable takes only the site address. I found it because the error message showed the full URL (a doubled path).
- WordPress returned 503: the readiness probe was timing out on /wp-login.php, so Traefik had no ready pod. [add what you changed: probe timeouts, CPU limit].
- Laptop sleep paused Docker's VM and made the cluster flaky. I turned off sleep while plugged in.
- Earlier in Phase 1: bitnami/kubectl tag vanished from Docker Hub, and the latest WooCommerce needed WordPress 7.0, so I pinned WooCommerce 10.3.6.

### Things I should be able to explain
- Why stateless? What would break if the server kept sessions?
- How is the basic auth header built, and why does the server never log it?
- What does a readiness probe do versus a liveness probe, and why did a tight one cause 503s?
- Why does `USER node` need `runAsUser: 1000` in Kubernetes?

### Still to learn / unsure about
- [One or two things you didn't fully understand yet.]


a database password only takes effect when the volume is first created, so rotating a password means recreating the volume or changing it inside the database. Also note that helm uninstall deleted the namespace because the chart owns it.


## Phase 3: Gateway (auth, upstream manager, /mcp)

### Step 3: Auth
- **Admin seed:** On startup the gateway creates the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (from a Secret), but only if the `users` table is empty. An advisory lock stops two pods from both inserting. Changing the Secret later does NOT change an existing admin. I have to delete the row and let it reseed.
- **Passwords:** hashed with argon2, never stored in plain text.
- **Session cookie:** `urumi_session` is httpOnly, so JavaScript can't read it. It is a small signed token `{userId, expiresAt}` with an HMAC-SHA256 signature made with `SESSION_SECRET`. The server recomputes the signature on each request and compares with `timingSafeEqual`. Tradeoff: logout only clears the cookie, so a stolen cookie stays valid until it expires (8 hours). A sessions table in the database would fix that.
- **API keys:** `urk_` + 32 random bytes. The full key is shown once. The database stores only the SHA-256 hash and a 12-character prefix. If the database leaks, the keys can't be used. SHA-256 is fine here (not argon2) because the key is long and random, not a guessable password.
- **Revoke:** sets `revoked_at` instead of deleting the row, so history is kept and `/mcp` can reject the key with a clear reason. Someone else's key returns 404, not 403, so ids can't be probed.
- **Known gaps (for the threat model):** no login rate limit; login is slightly faster for unknown emails (user enumeration); no server-side session revocation.

### Step 4: Upstream manager
- `servers` table is the registry of upstream MCP servers (slug, url, auth type, encrypted credential, enabled, status, last_error).
- **Credentials:** encrypted with AES-256-GCM. Stored as base64 of 12-byte IV + 16-byte auth tag + ciphertext. A new random IV for every value. GCM also detects tampering. The key comes from a Secret (`CREDENTIALS_KEY`, 32 bytes). If the key is lost, stored credentials can't be read and must be re-entered.
- **Decryption happens only in `upstream.ts`**, which is the one place that adds the upstream header. Nothing else ever sees an upstream credential.
- **One MCP client per enabled server**, with the tool list cached. Health check every 15 s with a 5 s timeout. Success means `connected` and a refreshed tool cache. Failure means `unreachable`, the error saved in `last_error`, and the client dropped. The next round builds a fresh client, so a server that comes back recovers on its own.
- Disabled servers are never contacted. A flag stops two check rounds from overlapping. The loop is not awaited at startup, so a slow upstream can't block the gateway.
- `mcp-woo` is seeded as slug `woo` at `http://mcp-woo/mcp` if missing.
- **Test:** scaled `mcp-woo` to 0 and the log showed `connected -> unreachable (fetch failed)`. Scaled back to 1 and it showed `unreachable -> connected`, with no gateway restart.

### Step 5: /mcp endpoint
- **Stateless:** every POST builds a fresh MCP server object and closes it when the response ends. No session is kept between requests, so any gateway replica can answer.
- **Auth order:** check the `Bearer urk_...` header, hash it, look it up. Missing, unknown or revoked means 401 plus an audit row with outcome `rejected`. A valid key updates `last_used_at`.
- **tools/list:** merges cached tools of enabled and connected servers as `<slug>__<tool>` with a `[slug]` description prefix. `Promise.allSettled` means one bad upstream can't break the whole list. This prefix is how `echo` from two servers won't collide.
- **tools/call:** split the name at the first `__`, check the server exists and is enabled, forward with a 20 s timeout, and turn any failure into `isError` with a clear message.
- **The user's key is never sent upstream.** The manager's own client holds the upstream credential.
- **Audit:** written in a `finally` block, so every call gets a row whether it succeeded, failed or was rejected.
- **Test result:** audit table showed `success` (woo / list_orders), `error` (unknown server `nope`) and `rejected` (revoked key).

### Things that went wrong and what I learned
- **Crash loop with the old pod still running:** the new gateway pod crashed with `CREDENTIALS_KEY must be set`. Copilot had skipped the env entry in `deployment.yaml`. The old pod kept serving, so the rollout hung on "pending termination" and the DB looked empty because the old code had no upstream manager. Lesson: read `kubectl logs <new pod>`, and check that a Secret is actually mapped to an env var, not just created.
- **A build that "succeeds" with old code:** if `npm run build` fails, `dist` keeps the old files, and Docker still builds an image. `Cannot POST /mcp` was the old image. Lesson: check `Test-Path dist\<file>.js` and read the build output.
- **Pasted wrapper in a YAML file:** a PowerShell `Set-Content` command ended up inside `deployment.yaml`, so Helm said "line 2: mapping values are not allowed". Also, `Set-Content -Encoding utf8` in Windows PowerShell adds a BOM. Edit chart files in VS Code.
- **Seed only runs on an empty table:** same lesson as the DB password and PVC earlier. Config that is applied once needs a delete-and-reseed to change.
- **Port-forward dies on every pod restart.** Restart it after each rollout.
- **PowerShell quoting:** psql output came back blank. Piping SQL through stdin works: `"select ...;" | kubectl exec -i postgres-0 -n urumi -- sh -c 'psql ...'`.
- **Never paste `secrets.local.yaml`** anywhere. I pasted it twice, so rotate `credentialsKey`, `sessionSecret` and the admin password before the demo.
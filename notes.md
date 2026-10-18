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




demo link https://vimeo.com/1239588452?share=copy&fl=sv&fe=ci

# Urumi MCP Gateway

Urumi runs a WooCommerce store, MCP servers, an MCP gateway, and a React dashboard on Kubernetes. The gateway is the only component that connects to upstream MCP servers. Dashboard chat and external MCP clients both use the gateway’s `/mcp` endpoint.

## Prerequisites

For a local cluster, install Docker, k3d, kubectl, Helm, Node.js 20+, and GNU Make. PowerShell is used by the checked-in shipping script. For production, prepare a k3s VPS, a container registry, a domain, cert-manager with a `ClusterIssuer`, and a storage class. The repository does not include a k3s installation or image-publishing script.

## Run locally on k3d

1. Create the cluster with Traefik reachable on local port 80:

   ```powershell
   k3d cluster create urumi -p "80:80@loadbalancer" --agents 1
   ```

2. Create your untracked local secrets file from the committed template, then fill it in locally. Do not commit the populated file:

   ```powershell
   Copy-Item .\charts\platform\secrets.example.yaml .\charts\platform\secrets.local.yaml
   ```

3. Build and import the images covered by the Makefile, then build/import `mcp-woo` using the checked-in shipping function:

   ```powershell
   make build
   make import
   . .\scripts\ship.ps1
   Build-McpWoo
   ```

   The Makefile builds/imports `mcp-everything`, `dashboard`, and `gateway`; `Build-McpWoo` handles `mcp-woo`. There is no `mcp-notes` image build/import helper in the repository. Disable that optional upstream for this from-scratch local deployment:

   ```powershell
   .\deploy.ps1 --set mcp-notes.enabled=false
   ```

   `deploy.ps1` updates Helm dependencies and installs/upgrades the platform using `values-local.yaml` and `secrets.local.yaml`. The setup Job is enabled in this path.

4. Open the dashboard at <http://app.127.0.0.1.nip.io> and the shop at <http://shop.127.0.0.1.nip.io>. `nip.io` resolves these `*.127.0.0.1.nip.io` names to loopback; k3d maps local port 80 to the cluster’s Traefik ingress, which routes by hostname.

The setup Job installs WordPress and WooCommerce, configures the shop and Cash on Delivery, creates sample products if the catalog is empty, and writes WooCommerce API credentials to the `woo-api` Kubernetes Secret. Admin and LLM credentials are supplied through the local secrets file; use the values you set there when signing in or configuring the LLM.

## VPS / k3s deployment

1. Install k3s on the VPS and prepare a registry that the cluster can pull from. The repository does not provide commands for installing k3s, publishing images, or installing cert-manager; perform those steps using your infrastructure’s procedures.
2. Copy `charts/platform/secrets.example.yaml` to an untracked `charts/platform/secrets.prod.yaml` on the deployment machine and populate it there. Replace the placeholders in `charts/platform/values-prod.yaml`: `<domain>`, `<registry>`, `<organization>`, `<release-tag>`, `<cluster-issuer>`, and `<storage-class>`. The production values configure HTTPS ingress annotations, secure cookies, larger resource limits, and replica counts. Do not commit real secrets or domains.
3. Once the referenced images are published and the cluster prerequisites are ready, deploy with Helm:

   ```powershell
   helm dependency update ./charts/platform
   helm upgrade --install urumi ./charts/platform --namespace urumi --create-namespace --values ./charts/platform/values-prod.yaml --values ./charts/platform/secrets.prod.yaml
   ```

   The checked-in production chart sets two gateway replicas, but rate-limit buckets are in-memory and per process; limits are not shared across replicas. This is not coordinated, high-availability rate limiting.

## Place an order

Open <http://shop.127.0.0.1.nip.io>, choose a sample product, add it to the cart, and complete checkout using Cash on Delivery. The setup Job enables COD. The order should then appear in the WooCommerce administration area at `/wp-admin` using the admin account configured in your local secrets.

## Connect an external MCP client

In the dashboard, open **API keys**, generate a key, and copy it immediately—the full value is shown only once. The gateway URL is `http://app.127.0.0.1.nip.io/mcp`. For Claude Code, replace the placeholder with your key:

```powershell
claude mcp add --transport http urumi http://app.127.0.0.1.nip.io/mcp --header "Authorization: Bearer <API_KEY>"
```

The gateway authenticates the key, applies the caller’s role permissions, aggregates enabled upstream tools, and records calls in the audit log. Never put an upstream server credential in the client configuration. Revoke a key from the API keys page if it is no longer needed.

## Use dashboard chat

Sign in to the dashboard, open **Chat**, and ask a question. Chat uses the same gateway `/mcp` route and role checks as external clients. In the default `search` mode, the model searches the tools visible to the caller, then invokes a selected tool through the gateway; set `CHAT_TOOL_MODE` to `all` to expose the full visible tool list to the model. Tool calls appear beneath the answer, and their audit entries use the real upstream server and tool names.

## How `mcp-woo` reaches WooCommerce

`mcp-woo` calls the WooCommerce REST API at the in-cluster WordPress service’s `/wp-json/wc/v3` endpoint. It uses the WooCommerce application password stored in the `woo-api` Kubernetes Secret. This uses WooCommerce’s supported, versioned API rather than shell access to WordPress. The gateway adds upstream credentials only when connecting to an upstream; users’ gateway keys are not forwarded.

## Upgrade and rollback

For local changes, rebuild/import the affected image and run `deploy.ps1` again. For a production release, update the image tag in `values-prod.yaml` and run the Helm upgrade command above. Inspect release history and roll back to a prior revision if needed:

```powershell
helm history urumi --namespace urumi
helm rollback urumi <REVISION> --namespace urumi
```

## Additional implemented features

- SSRF checks for registered upstream URLs: `services/gateway/src/ssrf.ts`.
- Default-deny and workload-specific NetworkPolicies: `charts/platform` templates.
- AES-256-GCM encryption for stored upstream credentials: `services/gateway/src/crypto.ts`.
- Admin-only tool permissions, enforced on listing and calls: `services/gateway/src/mcp.ts` and gateway chart values (`ADMIN_ONLY_TOOLS`).
- Search-then-call chat tool mode: `services/gateway/src/chat.ts` and gateway chart values (`CHAT_TOOL_MODE`).
- Per-server, 24-hour metrics endpoint and dashboard cards: `services/gateway/src/admin.ts` and `services/dashboard/src/App.tsx`.
- In-memory token-bucket rate limits for `/mcp` and `/api/chat`: `services/gateway/src/rate-limit.ts`, `services/gateway/src/mcp.ts`, and `services/gateway/src/chat.ts`.

## Not implemented or not production-complete

- Invite links are not implemented; admins can create members directly from the dashboard.
- OAuth is not implemented.
- Managed provisioning/hosting of arbitrary third-party MCP servers is not implemented; the gateway can connect to configured upstream MCP URLs.
- Multi-store support is not implemented; the platform is configured for one WooCommerce store.
- Production values set multiple gateway replicas, but shared rate-limit state and coordinated high-availability behavior are not implemented.
- The repository does not provide an `mcp-notes` image build/import helper or automation for k3s installation, image publishing, or cert-manager setup.

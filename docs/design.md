# Design

## Audit log

Gateway MCP calls use `source = mcp`, chat calls use `source = chat`, and administrative actions use `source = admin`. Admin action names (for example, `server.disable` and `api_key.revoke`) reuse the existing `audit_logs.tool` column. Server actions also record the server slug; API-key actions do not. Audit entries contain no credentials.

## Member management

Admins can list members and create member accounts from the dashboard. The gateway normalizes email addresses, hashes passwords with Argon2, and always assigns the `member` role. The member-management endpoints are admin-only; invite links are not part of this flow.

## Upstream URL SSRF guard

Admin-added and updated upstream URLs are resolved before saving. The gateway rejects URLs whose DNS answers include loopback, private, link-local, or reserved IP addresses, and repeats this check before connecting to an upstream. Exact in-cluster service hostnames may bypass DNS address checks when included in the comma-separated `SSRF_ALLOWED_HOSTS` environment variable; the Helm default is `mcp-woo,mcp-notes,mcp-everything`. Other hostnames must resolve only to public addresses.

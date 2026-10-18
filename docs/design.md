# Design

## Audit log

Gateway MCP calls use `source = mcp`, chat calls use `source = chat`, and administrative actions use `source = admin`. Admin action names (for example, `server.disable` and `api_key.revoke`) reuse the existing `audit_logs.tool` column. Server actions also record the server slug; API-key actions do not. Audit entries contain no credentials.

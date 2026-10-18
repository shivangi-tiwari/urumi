import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { db } from "./db/client.js";
import { apiKeys, auditLogs, servers } from "./db/schema.js";
import { getCachedTools, getClient } from "./upstream.js";

const callTimeoutMs = 20_000;
const maxToolNameLength = 64;

type Outcome = "success" | "error" | "rejected";

type AuditEntry = {
  userId: string | null;
  serverSlug: string | null;
  tool: string | null;
  startedAt: Date;
  durationMs: number;
  outcome: Outcome;
  errorMessage: string | null;
};

async function writeAudit(entry: AuditEntry) {
  try {
    await db.insert(auditLogs).values({ source: "mcp", ...entry });
  } catch (err) {
    console.error("audit write failed:", err);
  }
}

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; userId: string | null; error: string };

async function authenticate(req: Request): Promise<AuthResult> {
  const match = /^Bearer (urk_[0-9a-f]+)$/.exec(req.headers.authorization ?? "");
  if (!match) return { ok: false, userId: null, error: "Missing or malformed API key." };

  const keyHash = createHash("sha256").update(match[1]).digest("hex");
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  if (!key) return { ok: false, userId: null, error: "Unknown API key." };
  if (key.revokedAt) return { ok: false, userId: key.userId, error: "API key has been revoked." };

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  return { ok: true, userId: key.userId };
}

function buildServer(userId: string) {
  const server = new Server(
    { name: "urumi-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // tools/list: merge cached tools of enabled + connected servers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rows = await db.select().from(servers);
    const live = rows.filter((row) => row.enabled && row.status === "connected");
    const results = await Promise.allSettled(
      live.map(async (row) =>
        getCachedTools(row.slug).map((tool) => ({
          ...tool,
          name: `${row.slug}__${tool.name}`,
          description: `[${row.slug}] ${tool.description ?? ""}`.trim(),
        })),
      ),
    );
    const tools = results
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((tool) => tool.name.length <= maxToolNameLength);
    return { tools };
  });

  // tools/call: split prefix, check server, forward with timeout, audit every call
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAt = new Date();
    const started = Date.now();
    const fullName = request.params.name;
    const sep = fullName.indexOf("__");
    const slug = sep > 0 ? fullName.slice(0, sep) : null;
    const tool = sep > 0 ? fullName.slice(sep + 2) : fullName;
    let outcome: Outcome = "success";
    let message: string | null = null;

    const fail = (text: string) => {
      outcome = "error";
      message = text;
      return { isError: true, content: [{ type: "text" as const, text }] };
    };

    try {
      if (!slug) return fail(`Unknown tool '${fullName}'. Tool names look like <server>__<tool>.`);

      const [row] = await db.select().from(servers).where(eq(servers.slug, slug)).limit(1);
      if (!row) return fail(`Unknown server '${slug}'.`);
      if (!row.enabled) return fail(`Server '${slug}' is disabled.`);

      const client = getClient(slug);
      if (!client) return fail(`Upstream '${slug}' unreachable: ${row.lastError ?? "not connected"}`);

      // The user's key is never sent upstream; the manager's client holds the upstream credential.
      const result = await client.callTool(
        { name: tool, arguments: request.params.arguments },
        undefined,
        { timeout: callTimeoutMs },
      );
      if (result.isError) {
        outcome = "error";
        message = "Upstream tool returned an error.";
      }
      return result as any;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return fail(`Upstream '${slug}' unreachable: ${text}`.slice(0, 500));
    } finally {
      await writeAudit({
        userId,
        serverSlug: slug,
        tool: slug ? tool : fullName,
        startedAt,
        durationMs: Date.now() - started,
        outcome,
        errorMessage: message,
      });
    }
  });

  return server;
}

export async function handleMcp(req: Request, res: Response) {
  try {
    const auth = await authenticate(req);
    if (!auth.ok) {
      await writeAudit({
        userId: auth.userId,
        serverSlug: null,
        tool: null,
        startedAt: new Date(),
        durationMs: 0,
        outcome: "rejected",
        errorMessage: auth.error,
      });
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: auth.error }, id: null });
      return;
    }

    const server = buildServer(auth.userId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error." }, id: null });
    }
  }
}

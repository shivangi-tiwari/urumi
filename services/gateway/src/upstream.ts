import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { servers } from "./db/schema.js";
import { decrypt } from "./crypto.js";

type Server = typeof servers.$inferSelect;
type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Entry = { client: Client; tools: Tool[] };

const checkIntervalMs = 15_000;
const checkTimeoutMs = 5_000;

// One cached client + tool list per enabled, reachable server (key = slug)
const entries = new Map<string, Entry>();
let checking = false;

function buildHeaders(server: Server): Record<string, string> {
  if (server.authType === "none" || !server.credentialEncrypted) return {};
  const credential = decrypt(server.credentialEncrypted);
  if (server.authType === "bearer") return { Authorization: `Bearer ${credential}` };
  if (server.authType === "header" && server.headerName) return { [server.headerName]: credential };
  return {};
}

async function dropClient(slug: string) {
  const entry = entries.get(slug);
  entries.delete(slug);
  if (entry) {
    try {
      await entry.client.close();
    } catch {
      // ignore close errors
    }
  }
}

async function checkOne(server: Server) {
  let error: string | null = null;
  let created: Client | undefined;
  try {
    let entry = entries.get(server.slug);
    if (!entry) {
      created = new Client({ name: "urumi-gateway", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: buildHeaders(server) },
      });
      await created.connect(transport, { timeout: checkTimeoutMs });
      entry = { client: created, tools: [] };
      entries.set(server.slug, entry);
    }
    const result = await entry.client.listTools(undefined, { timeout: checkTimeoutMs });
    entry.tools = result.tools;
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await dropClient(server.slug);
    if (created) {
      try {
        await created.close();
      } catch {
        // ignore close errors
      }
    }
  }

  const status = error ? "unreachable" : "connected";
  if (status !== server.status) {
    console.log(`upstream '${server.slug}': ${server.status} -> ${status}${error ? ` (${error})` : ""}`);
  }
  await db.update(servers)
    .set({ status, lastError: error, lastCheckedAt: new Date() })
    .where(eq(servers.id, server.id));
}

async function checkAll() {
  if (checking) return; // never overlap two rounds
  checking = true;
  try {
    const rows = await db.select().from(servers);
    const enabled = rows.filter((row) => row.enabled);
    for (const row of rows) {
      if (!row.enabled) await dropClient(row.slug); // disabled servers are never contacted
    }
    await Promise.allSettled(enabled.map((row) => checkOne(row)));
  } catch (err) {
    console.error("upstream check round failed:", err);
  } finally {
    checking = false;
  }
}

export async function seedWooServer() {
  const [existing] = await db.select({ id: servers.id }).from(servers).where(eq(servers.slug, "woo")).limit(1);
  if (existing) return;
  await db.insert(servers).values({
    slug: "woo",
    name: "WooCommerce store",
    url: process.env.MCP_WOO_URL ?? "http://mcp-woo/mcp",
    authType: "none",
  }).onConflictDoNothing();
}

export function startUpstreamManager() {
  void checkAll();
  setInterval(() => void checkAll(), checkIntervalMs);
}

// Used by the /mcp endpoint in step 5
export function getCachedTools(slug: string): Tool[] {
  return entries.get(slug)?.tools ?? [];
}

export function getClient(slug: string): Client | undefined {
  return entries.get(slug)?.client;
}

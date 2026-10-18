import { and, desc, eq, type SQL } from "drizzle-orm";
import { Router } from "express";
import { writeAdminAudit } from "./audit.js";
import { requireRole, requireSession } from "./auth.js";
import { db } from "./db/client.js";
import { apiKeys, auditLogs, servers, users } from "./db/schema.js";
import { encrypt } from "./crypto.js";
import { dropClient, getCachedTools } from "./upstream.js";

export const adminRouter = Router();

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function publicServer(row: typeof servers.$inferSelect) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: publicUrl(row.url),
    authType: row.authType,
    headerName: row.headerName,
    hasCredential: Boolean(row.credentialEncrypted),
    enabled: row.enabled,
    status: row.status,
    lastError: row.lastError?.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@") ?? null,
    lastCheckedAt: row.lastCheckedAt,
    tools: getCachedTools(row.slug).map((tool) => tool.name),
  };
}

function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "Invalid URL";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 100;
}

function validUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function validAuthType(value: unknown): value is "none" | "bearer" | "header" {
  return value === "none" || value === "bearer" || value === "header";
}

adminRouter.get("/servers", requireSession, requireRole("admin"), async (_req, res) => {
  try {
    const rows = await db.select().from(servers).orderBy(servers.slug);
    res.json({ servers: rows.map(publicServer) });
  } catch {
    res.status(500).json({ error: "Servers could not be loaded." });
  }
});

adminRouter.post("/servers", requireSession, requireRole("admin"), async (req, res) => {
  try {
    const body = req.body;
    if (!isObject(body)) {
      res.status(400).json({ error: "A server object is required." });
      return;
    }
    if (typeof body.slug !== "string" || body.slug.length > 20 || !slugPattern.test(body.slug)) {
      res.status(400).json({ error: "Slug must use lowercase letters, numbers, and single underscores, and be at most 20 characters." });
      return;
    }
    if (!validName(body.name)) {
      res.status(400).json({ error: "Name must be a non-empty string of at most 100 characters." });
      return;
    }
    if (!validUrl(body.url)) {
      res.status(400).json({ error: "URL must be a valid HTTP or HTTPS URL." });
      return;
    }
    if (!validAuthType(body.authType)) {
      res.status(400).json({ error: "Auth type must be none, bearer, or header." });
      return;
    }
    if (body.authType === "header" && (typeof body.headerName !== "string" || body.headerName.trim().length === 0)) {
      res.status(400).json({ error: "Header name is required for header authentication." });
      return;
    }
    if (body.authType !== "none" && (typeof body.credential !== "string" || body.credential.length === 0)) {
      res.status(400).json({ error: "Credential is required for bearer or header authentication." });
      return;
    }
    if (body.credential !== undefined && typeof body.credential !== "string") {
      res.status(400).json({ error: "Credential must be a string." });
      return;
    }

    const [created] = await db.insert(servers).values({
      slug: body.slug,
      name: body.name,
      url: body.url,
      authType: body.authType,
      headerName: body.authType === "header" ? body.headerName as string : null,
      credentialEncrypted: body.authType === "none" ? null : encrypt(body.credential as string),
      status: "unknown",
    }).onConflictDoNothing({ target: servers.slug }).returning();

    if (!created) {
      res.status(409).json({ error: "A server with that slug already exists." });
      return;
    }
    const user = res.locals.user as typeof users.$inferSelect;
    await writeAdminAudit(user.id, "server.create", created.slug);
    res.status(201).json({ server: publicServer(created) });
  } catch {
    res.status(500).json({ error: "Server could not be created." });
  }
});

adminRouter.patch("/servers/:id", requireSession, requireRole("admin"), async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!uuidPattern.test(id)) {
      res.status(404).json({ error: "Server not found." });
      return;
    }

    const [existing] = await db.select().from(servers).where(eq(servers.id, id)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Server not found." });
      return;
    }
    if (!isObject(req.body)) {
      res.status(400).json({ error: "A server update object is required." });
      return;
    }

    const body = req.body;
    const updates: Partial<typeof servers.$inferInsert> = {};
    let connectionChanged = false;

    if (Object.hasOwn(body, "enabled")) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: "Enabled must be a boolean." });
        return;
      }
      updates.enabled = body.enabled;
      if (body.enabled) updates.status = "unknown";
    }
    if (Object.hasOwn(body, "name")) {
      if (!validName(body.name)) {
        res.status(400).json({ error: "Name must be a non-empty string of at most 100 characters." });
        return;
      }
      updates.name = body.name;
    }
    if (Object.hasOwn(body, "url")) {
      if (!validUrl(body.url)) {
        res.status(400).json({ error: "URL must be a valid HTTP or HTTPS URL." });
        return;
      }
      updates.url = body.url;
      connectionChanged = true;
    }
    if (Object.hasOwn(body, "credential")) {
      if (typeof body.credential !== "string" || body.credential.length === 0) {
        res.status(400).json({ error: "Credential must be a non-empty string." });
        return;
      }
      updates.credentialEncrypted = encrypt(body.credential);
      connectionChanged = true;
    }

    if (connectionChanged) {
      updates.status = "unknown";
      updates.lastError = null;
    }

    let updated = existing;
    if (Object.keys(updates).length) {
      const [saved] = await db.update(servers).set(updates).where(eq(servers.id, id)).returning();
      if (saved) updated = saved;

      const user = res.locals.user as typeof users.$inferSelect;
      const enabledOnly = Object.keys(body).length === 1 && typeof body.enabled === "boolean";
      const action = enabledOnly
        ? body.enabled ? "server.enable" : "server.disable"
        : "server.update";
      await writeAdminAudit(user.id, action, existing.slug);
    }

    if (connectionChanged || body.enabled === false) await dropClient(existing.slug);
    res.json({ server: publicServer(updated) });
  } catch {
    res.status(500).json({ error: "Server could not be updated." });
  }
});

adminRouter.delete("/servers/:id", requireSession, requireRole("admin"), async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!uuidPattern.test(id)) {
      res.status(404).json({ error: "Server not found." });
      return;
    }

    const [existing] = await db.select({ id: servers.id, slug: servers.slug })
      .from(servers)
      .where(eq(servers.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Server not found." });
      return;
    }

    await dropClient(existing.slug);
    await db.delete(servers).where(eq(servers.id, id));
    const user = res.locals.user as typeof users.$inferSelect;
    await writeAdminAudit(user.id, "server.delete", existing.slug);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "Server could not be deleted." });
  }
});

adminRouter.get("/keys", requireSession, async (_req, res) => {
  try {
    const user = res.locals.user as typeof users.$inferSelect;
    const baseQuery = db.select({
      id: apiKeys.id,
      prefix: apiKeys.prefix,
      userId: apiKeys.userId,
      createdAt: apiKeys.createdAt,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      userEmail: users.email,
    }).from(apiKeys).innerJoin(users, eq(apiKeys.userId, users.id));
    const keys = user.role === "admin"
      ? await baseQuery.orderBy(desc(apiKeys.createdAt))
      : await baseQuery.where(eq(apiKeys.userId, user.id)).orderBy(desc(apiKeys.createdAt));
    res.json({ keys });
  } catch {
    res.status(500).json({ error: "API keys could not be loaded." });
  }
});

adminRouter.get("/audit", requireSession, requireRole("admin"), async (req, res) => {
  try {
    const conditions: SQL[] = [];
    if (req.query.user !== undefined) {
      if (typeof req.query.user !== "string" || !uuidPattern.test(req.query.user)) {
        res.status(400).json({ error: "User filter must be a valid UUID." });
        return;
      }
      conditions.push(eq(auditLogs.userId, req.query.user));
    }
    if (req.query.server !== undefined) {
      if (typeof req.query.server !== "string") {
        res.status(400).json({ error: "Server filter must be a single string." });
        return;
      }
      conditions.push(eq(auditLogs.serverSlug, req.query.server));
    }
    if (req.query.outcome !== undefined) {
      if (req.query.outcome !== "success" && req.query.outcome !== "error" && req.query.outcome !== "rejected") {
        res.status(400).json({ error: "Outcome must be success, error, or rejected." });
        return;
      }
      conditions.push(eq(auditLogs.outcome, req.query.outcome));
    }

    let limit = 100;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== "string") {
        res.status(400).json({ error: "Limit must be an integer from 1 to 500." });
        return;
      }
      limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        res.status(400).json({ error: "Limit must be an integer from 1 to 500." });
        return;
      }
    }

    const entries = await db.select({
      id: auditLogs.id,
      userEmail: users.email,
      source: auditLogs.source,
      serverSlug: auditLogs.serverSlug,
      tool: auditLogs.tool,
      startedAt: auditLogs.startedAt,
      durationMs: auditLogs.durationMs,
      outcome: auditLogs.outcome,
      errorMessage: auditLogs.errorMessage,
    }).from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.startedAt))
      .limit(limit);

    res.json({ entries });
  } catch {
    res.status(500).json({ error: "Audit entries could not be loaded." });
  }
});

import { db } from "./db/client.js";
import { auditLogs } from "./db/schema.js";

export type AdminAuditAction =
  | "api_key.create"
  | "api_key.revoke"
  | "server.create"
  | "server.update"
  | "server.enable"
  | "server.disable"
  | "server.delete"
  | "member.create"
  | "member.delete";

export async function writeAdminAudit(
  userId: string,
  action: AdminAuditAction,
  {
    actorEmail,
    serverSlug = null,
    detail = null,
  }: {
    actorEmail: string;
    serverSlug?: string | null;
    detail?: string | null;
  },
) {
  try {
    await db.insert(auditLogs).values({
      userId,
      actorEmail,
      source: "admin",
      serverSlug,
      tool: action,
      detail,
      startedAt: new Date(),
      durationMs: 0,
      outcome: "success",
      errorMessage: null,
    });
  } catch (err) {
    console.error(`audit write failed for ${action}:`, err);
  }
}

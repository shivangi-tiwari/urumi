import argon2 from "argon2";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Router, type Request, type RequestHandler } from "express";
import { writeAdminAudit } from "./audit.js";
import { apiKeys, users } from "./db/schema.js";
import { db } from "./db/client.js";

const sessionCookieName = "urumi_session";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;
const sessionSecretEnv = process.env.SESSION_SECRET;

if (!sessionSecretEnv) {
  throw new Error("SESSION_SECRET must be set.");
}

const sessionSecret: string = sessionSecretEnv;

type User = typeof users.$inferSelect;
type UserRole = "admin" | "member";

function publicUser(user: User) {
  return { id: user.id, email: user.email, role: user.role };
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax" as const,
    path: "/",
  };
}

function signSession(userId: string) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + sessionLifetimeMs,
  })).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function sessionUserId(req: Request): string | undefined {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  const token = cookie?.slice(sessionCookieName.length + 1);
  if (!token) return undefined;

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;

  const expected = Buffer.from(createHmac("sha256", sessionSecret).update(payload).digest("base64url"));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof session.userId !== "string" ||
      typeof session.expiresAt !== "number" ||
      session.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return session.userId;
  } catch {
    return undefined;
  }
}

export const requireSession: RequestHandler = (req, res, next) => {
  void (async () => {
    try {
      const userId = sessionUserId(req);
      if (!userId) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }

      const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }
      if (user.role !== "admin" && user.role !== "member") {
        res.status(403).json({ error: "Role is not permitted." });
        return;
      }

      res.locals.user = user;
      next();
    } catch {
      res.status(500).json({ error: "Authentication could not be completed." });
    }
  })();
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (_req, res, next) => {
    const user = res.locals.user as User | undefined;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: "Role is not permitted." });
      return;
    }
    next();
  };
}

export async function seedFirstAdmin() {
  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (existing) return;

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the first admin.");
  }
  const passwordHash = await argon2.hash(password);

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(731942184)`);
    const [user] = await tx.select({ id: users.id }).from(users).limit(1);
    if (!user) {
      await tx.insert(users).values({ email, passwordHash, role: "admin" }).onConflictDoNothing();
    }
  });
}

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  try {
    const [user] = await db.select().from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      res.status(401).json({ error: "Invalid email or password." });
      return;
    }
    if (user.role !== "admin" && user.role !== "member") {
      res.status(403).json({ error: "Role is not permitted." });
      return;
    }

    res.cookie(sessionCookieName, signSession(user.id), {
      ...cookieOptions(),
      maxAge: sessionLifetimeMs,
    });
    res.json({ user: publicUser(user) });
  } catch {
    res.status(500).json({ error: "Login could not be completed." });
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(sessionCookieName, cookieOptions());
  res.status(204).end();
});

authRouter.get("/me", requireSession, (_req, res) => {
  res.json({ user: publicUser(res.locals.user as User) });
});

authRouter.post("/keys", requireSession, requireRole("admin", "member"), async (_req, res) => {
  try {
    const user = res.locals.user as User;
    const key = `urk_${randomBytes(32).toString("hex")}`;
    const prefix = key.slice(0, 12);
    const keyHash = createHash("sha256").update(key).digest("hex");
    const [created] = await db.insert(apiKeys).values({
      userId: user.id,
      prefix,
      keyHash,
    }).returning({ id: apiKeys.id });

    await writeAdminAudit(user.id, "api_key.create");
    res.status(201).json({ id: created.id, prefix, key });
  } catch {
    res.status(500).json({ error: "API key could not be created." });
  }
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

authRouter.delete("/keys/:id", requireSession, async (req, res) => {
  try {
    const user = res.locals.user as User;
    const keyId = String(req.params.id);
    if (!uuidPattern.test(keyId)) {
      res.status(404).json({ error: "API key not found." });
      return;
    }

    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).limit(1);
    if (!key || (key.userId !== user.id && user.role !== "admin")) {
      res.status(404).json({ error: "API key not found." });
      return;
    }

    if (!key.revokedAt) {
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
      await writeAdminAudit(user.id, "api_key.revoke");
    }
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "API key could not be revoked." });
  }
});

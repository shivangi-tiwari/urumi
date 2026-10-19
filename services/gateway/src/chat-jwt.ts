import { createHmac, timingSafeEqual } from "node:crypto";

const issuer = "urumi-gateway";
const audience = "urumi-gateway-mcp";
const lifetimeSeconds = 5 * 60;
const secret = process.env.CHAT_JWT_SECRET;

if (!secret || Buffer.byteLength(secret) < 32) {
  throw new Error("CHAT_JWT_SECRET must be set to at least 32 bytes.");
}
const signingSecret: string = secret;

type ChatClaims = {
  sub: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
};

function signature(input: string): string {
  return createHmac("sha256", signingSecret).update(input).digest("base64url");
}

export function mintChatJwt(userId: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const claims: ChatClaims = {
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
    iss: issuer,
    aud: audience,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${signature(unsigned)}`;
}

export function verifyChatJwt(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const [headerPart, payloadPart, receivedSignature] = parts;
  if (!headerPart || !payloadPart || !receivedSignature) return undefined;

  const expected = Buffer.from(signature(`${headerPart}.${payloadPart}`));
  const received = Buffer.from(receivedSignature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;

  try {
    const header: unknown = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const claims: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (
      typeof header !== "object" || header === null ||
      !("alg" in header) || header.alg !== "HS256" ||
      typeof claims !== "object" || claims === null ||
      !("sub" in claims) || typeof claims.sub !== "string" ||
      !("iat" in claims) || typeof claims.iat !== "number" ||
      !("exp" in claims) || typeof claims.exp !== "number" ||
      !("iss" in claims) || claims.iss !== issuer ||
      !("aud" in claims) || claims.aud !== audience
    ) {
      return undefined;
    }
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now || claims.exp - claims.iat > lifetimeSeconds || claims.iat > now + 30) {
      return undefined;
    }
    return claims.sub;
  } catch {
    return undefined;
  }
}

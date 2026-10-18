import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const keyBase64 = process.env.CREDENTIALS_KEY;
if (!keyBase64) {
  throw new Error("CREDENTIALS_KEY must be set.");
}
const key = Buffer.from(keyBase64, "base64");
if (key.length !== 32) {
  throw new Error("CREDENTIALS_KEY must be 32 bytes, base64 encoded.");
}

// Stored format (base64): 12-byte IV + 16-byte auth tag + ciphertext
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function decrypt(payload: string): string {
  const raw = Buffer.from(payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

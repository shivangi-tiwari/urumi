type Bucket = {
  tokens: number;
  updatedAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export function configuredRateLimit(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function createTokenBucket(ratePerMinute: number): (key: string) => RateLimitResult {
  const buckets = new Map<string, Bucket>();
  const refillPerMs = ratePerMinute / 60_000;

  return (key) => {
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: ratePerMinute, updatedAt: now };
    bucket.tokens = Math.min(ratePerMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    buckets.set(key, bucket);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
    };
  };
}

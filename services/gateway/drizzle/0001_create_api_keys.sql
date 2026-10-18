CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "prefix" text NOT NULL,
  "key_hash" text NOT NULL UNIQUE,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  "last_used_at" timestamptz
);

CREATE INDEX "api_keys_user_id_idx" ON "api_keys" ("user_id");

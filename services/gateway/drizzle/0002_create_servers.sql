CREATE TABLE "servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "auth_type" text DEFAULT 'none' NOT NULL,
  "header_name" text,
  "credential_encrypted" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "status" text DEFAULT 'unknown' NOT NULL,
  "last_error" text,
  "last_checked_at" timestamptz
);

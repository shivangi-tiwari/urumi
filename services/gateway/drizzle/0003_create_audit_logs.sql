CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "source" text NOT NULL,
  "server_slug" text,
  "tool" text,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "duration_ms" integer DEFAULT 0 NOT NULL,
  "outcome" text NOT NULL,
  "error_message" text
);

CREATE INDEX "audit_logs_started_at_idx" ON "audit_logs" ("started_at");

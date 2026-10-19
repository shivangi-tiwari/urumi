ALTER TABLE "audit_logs" ADD COLUMN "actor_email" text;
ALTER TABLE "audit_logs" ADD COLUMN "detail" text;

UPDATE "audit_logs"
SET "actor_email" = "users"."email"
FROM "users"
WHERE "audit_logs"."user_id" = "users"."id";

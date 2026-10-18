import express from "express";
import { authRouter, seedFirstAdmin } from "./auth.js";
import { runMigrations } from "./db/migrate.js";

await runMigrations();
await seedFirstAdmin();

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(express.json({ limit: "16kb" }));
app.use("/api", authRouter);

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`gateway listening on port ${port}`);
});

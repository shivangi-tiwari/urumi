import express from "express";
import { runMigrations } from "./db/migrate.js";

await runMigrations();

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`gateway listening on port ${port}`);
});

import { timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const notesToken = process.env.NOTES_TOKEN;
if (!notesToken) {
  throw new Error("NOTES_TOKEN must be set.");
}

const app = express();
const port = Number(process.env.PORT ?? 3000);
const notes: Array<{ id: number; text: string; created_at: string }> = [];
let nextId = 1;

app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const expected = Buffer.from(`Bearer ${notesToken}`);
  const provided = Buffer.from(req.get("authorization") ?? "");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = new McpServer({
    name: "mcp-notes",
    version: "1.0.0",
  });

  server.registerTool(
    "add_note",
    {
      description: "Add a note to the in-memory notes list.",
      inputSchema: {
        text: z.string().min(1).max(1000).describe("Text of the note to add (1–1000 characters)."),
      },
    },
    async ({ text }) => {
      const note = { id: nextId++, text, created_at: new Date().toISOString() };
      notes.push(note);
      return { content: [{ type: "text", text: JSON.stringify(note) }] };
    },
  );

  server.registerTool(
    "list_notes",
    {
      description: "List all notes in memory.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify(notes) }] }),
  );

  server.registerTool(
    "echo",
    {
      description: "Echo a message back.",
      inputSchema: {
        message: z.string().describe("Message to echo back."),
      },
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP request failed." });
    }
  }
});

app.listen(port, () => {
  console.log("mcp-notes listening on port 3000");
});

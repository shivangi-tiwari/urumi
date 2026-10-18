import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const wooBaseUrl = process.env.WOO_BASE_URL ?? "http://wordpress";

app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const server = new McpServer({
    name: "mcp-woo",
    version: "1.0.0",
  });

  server.registerTool(
    "list_products",
    {
      description: "List products from the WooCommerce store.",
      inputSchema: {
        search: z.string().optional().describe("Filter products by a search term."),
        per_page: z.number().int().min(1).max(100).optional().describe("Maximum number of products to return (1–100)."),
      },
    },
    async ({ search, per_page }) => {
      const requestPath = "/wp-json/wc/v3/products";
      let httpStatus: number | undefined;
      let errorMessage = "WooCommerce request failed.";

      try {
        const user = process.env.WOO_API_USER;
        const password = process.env.WOO_API_PASSWORD;
        if (!user || !password) {
          throw new Error("WOO_API_USER and WOO_API_PASSWORD must be set.");
        }

        const url = new URL(`${wooBaseUrl.replace(/\/+$/, "")}${requestPath}`);
        if (search) url.searchParams.set("search", search);
        if (per_page !== undefined) url.searchParams.set("per_page", String(per_page));

        const response = await fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
            Accept: "application/json",
          },
        });
        httpStatus = response.status;

        if (!response.ok) {
          errorMessage = `WooCommerce API returned an error for ${url.origin}${url.pathname}.`;
          throw new Error(errorMessage);
        }

        const products = (await response.json()) as Array<{
          id: number;
          name: string;
          price: string;
          status: string;
        }>;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                products.map(({ id, name, price, status }) => ({ id, name, price, status })),
              ),
            },
          ],
        };
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const causeCode =
          typeof cause === "object" && cause !== null && "code" in cause &&
          typeof cause.code === "string" && /^[A-Z0-9_]+$/.test(cause.code)
            ? cause.code
            : undefined;
        const details = [
          `HTTP status: ${httpStatus ?? "unavailable"}`,
          `path: ${requestPath}`,
          causeCode ? `cause: ${causeCode}` : undefined,
        ].filter(Boolean).join("; ");

        return {
          content: [
            {
              type: "text",
              text: `${errorMessage} (${details})`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "MCP request failed.",
      });
    }
  }
});

app.listen(port, () => {
  console.log(`mcp-woo listening on port ${port}`);
});

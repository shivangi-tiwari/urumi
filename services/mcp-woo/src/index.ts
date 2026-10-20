import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const wooBaseUrl = process.env.WOO_BASE_URL ?? "http://wordpress";
const wooApiPath = "/wp-json/wc/v3";
const orderStatuses = ["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "checkout-draft"] as const;
const perPageSchema = z.number().int().min(1).max(100).optional().describe("Maximum number of results to return (1–100).");

function buildServer() {
  const mcpServer = new McpServer({
    name: "mcp-woo",
    version: "1.0.0",
  });

  mcpServer.registerTool(
    "list_products",
    {
      description: "List products from the WooCommerce store.",
      inputSchema: {
        search: z.string().optional().describe("Filter products by a search term."),
        per_page: perPageSchema,
      },
    },
    async ({ search, per_page }) => {
      try {
        const query: Record<string, string> = {};
        if (search) query.search = search;
        if (per_page !== undefined) query.per_page = String(per_page);
        const products = await wooRequest<WooProduct[]>("/products", { query });
        return toolSuccess(products.map(({ id, name, price, status }) => ({ id, name, price, status })));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  mcpServer.registerTool(
    "create_product",
    {
      description: "Create and publish a WooCommerce product.",
      inputSchema: {
        name: z.string().min(1).describe("Product name."),
        regular_price: z.string().min(1).describe("Product regular price as a decimal string."),
        description: z.string().optional().describe("Optional product description."),
      },
    },
    async ({ name, regular_price, description }) => {
      try {
        const product = await wooRequest<WooProduct>("/products", {
          method: "POST",
          body: { name, regular_price, description, status: "publish" },
        });
        return toolSuccess({
          id: product.id,
          name: product.name,
          price: product.price,
          status: product.status,
        });
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  mcpServer.registerTool(
    "list_orders",
    {
      description: "List WooCommerce orders, optionally filtering by creation date and status.",
      inputSchema: {
        after: z.string().datetime({ offset: true }).optional().describe("Return orders created after this ISO 8601 date and time."),
        status: z.enum(orderStatuses).optional().describe("Filter by WooCommerce order status."),
        per_page: perPageSchema,
      },
    },
    async ({ after, status, per_page }) => {
      try {
        const query: Record<string, string> = {};
        if (after) query.after = after;
        if (status) query.status = status;
        if (per_page !== undefined) query.per_page = String(per_page);
        const orders = await wooRequest<WooOrder[]>("/orders", { query });
        return toolSuccess(orders.map(trimOrder));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  mcpServer.registerTool(
    "get_order",
    {
      description: "Get a WooCommerce order by its numeric ID.",
      inputSchema: {
        id: z.number().int().positive().describe("WooCommerce order ID."),
      },
    },
    async ({ id }) => {
      try {
        const order = await wooRequest<WooOrder>(`/orders/${id}`);
        return toolSuccess(trimOrder(order));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  mcpServer.registerTool(
    "update_order_status",
    {
      description: "Update the status of a WooCommerce order.",
      inputSchema: {
        id: z.number().int().positive().describe("WooCommerce order ID."),
        status: z.enum(orderStatuses).describe("New WooCommerce order status."),
      },
    },
    async ({ id, status }) => {
      try {
        const order = await wooRequest<WooOrder>(`/orders/${id}`, {
          method: "PUT",
          body: { status },
        });
        return toolSuccess(trimOrder(order));
      } catch (error) {
        return toolFailure(error);
      }
    },
  );

  return mcpServer;
}

type WooProduct = {
  id: number;
  name: string;
  price: string;
  status: string;
};

type WooOrder = {
  id: number;
  status: string;
  total: string;
  date_created: string;
  billing: {
    first_name: string;
    last_name: string;
  };
  line_items: Array<{
    name: string;
    quantity: number;
    total: string;
  }>;
};

class WooCommerceError extends Error {}

function safeRequestUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function getCauseCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause &&
    typeof cause.code === "string" && /^[A-Z0-9_]+$/.test(cause.code)
    ? cause.code
    : undefined;
}

async function wooRequest<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PUT"; query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const user = process.env.WOO_API_USER;
  const password = process.env.WOO_API_PASSWORD;
  if (!user || !password) {
    throw new WooCommerceError("WooCommerce credentials are not configured.");
  }

  let url: URL;
  try {
    url = new URL(`${wooBaseUrl.replace(/\/+$/, "")}${wooApiPath}${path}`);
  } catch {
    throw new WooCommerceError("WooCommerce base URL is invalid.");
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    const causeCode = getCauseCode(error);
    throw new WooCommerceError(
      `WooCommerce request failed for ${safeRequestUrl(url)}${causeCode ? ` (cause: ${causeCode})` : ""}.`,
    );
  }

  if (!response.ok) {
    throw new WooCommerceError(
      `WooCommerce API returned HTTP ${response.status} for ${safeRequestUrl(url)}.`,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new WooCommerceError(
      `WooCommerce returned invalid JSON for ${safeRequestUrl(url)} (HTTP ${response.status}).`,
    );
  }
}

function toolSuccess(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

function toolFailure(error: unknown) {
  const message = error instanceof WooCommerceError ? error.message : "WooCommerce request failed.";
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function trimOrder(order: WooOrder) {
  return {
    id: order.id,
    status: order.status,
    total: order.total,
    date: order.date_created,
    customer_name: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(" "),
    line_items: order.line_items.map(({ name, quantity, total }) => ({ name, quantity, total })),
  };
}

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/mcp", async (req, res) => {
  const mcpServer = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
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

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Router, type Request, type Response } from "express";
import { mintChatJwt } from "./chat-jwt.js";
import { requireSession } from "./auth.js";
import { writeAudit } from "./mcp.js";
import { configuredRateLimit, createTokenBucket } from "./rate-limit.js";

const model = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
const baseURL = process.env.LLM_BASE_URL;
const mcpUrl = process.env.GATEWAY_MCP_URL ?? "http://gateway:3000/mcp";
const chatToolMode = process.env.CHAT_TOOL_MODE ?? "search";
const chatRateLimit = createTokenBucket(configuredRateLimit("CHAT_RATE_LIMIT_PER_MINUTE", 10));
const maxRounds = 8;
const maxMessages = 40;
const maxMessageLength = 8_000;

if (!model) throw new Error("LLM_MODEL must be set.");
if (!apiKey) throw new Error("LLM_API_KEY must be set.");
if (!baseURL) throw new Error("LLM_BASE_URL must be set.");
if (chatToolMode !== "search" && chatToolMode !== "all") {
  throw new Error('CHAT_TOOL_MODE must be "search" or "all".');
}
const configuredApiKey: string = apiKey;

const openai = new OpenAI({ apiKey: configuredApiKey, baseURL });

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolCallSummary = {
  name: string;
  args: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
};

const searchToolsDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_tools",
    description: "Find relevant tools by keyword in their names and descriptions.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Keywords describing the tool you need." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

const callToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "call_tool",
    description: "Call a tool by its exact exposed name returned by search_tools.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact exposed tool name from search_tools." },
        arguments: { type: "object", additionalProperties: true, description: "Arguments for that tool." },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    },
  },
};

function searchVisibleTools(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  query: string,
): Array<{ name: string; description: string }> {
  const keywords = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  if (keywords.length === 0) return [];

  return tools
    .map((tool, index) => {
      const name = tool.name.toLowerCase();
      const description = (tool.description ?? "").toLowerCase();
      const score = keywords.reduce((total, keyword) =>
        total + (name.includes(keyword) ? 3 : 0) + (description.includes(keyword) ? 1 : 0), 0);
      return { tool, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 8)
    .map(({ tool }) => ({
      name: tool.name,
      description: (tool.description ?? "").slice(0, 160),
    }));
}

function parseMessages(value: unknown): ChatMessage[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxMessages) return undefined;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (
      typeof item !== "object" || item === null ||
      !("role" in item) || (item.role !== "user" && item.role !== "assistant") ||
      !("content" in item) || typeof item.content !== "string" ||
      item.content.length === 0 || item.content.length > maxMessageLength
    ) {
      return undefined;
    }
    messages.push({ role: item.role, content: item.content });
  }
  if (!messages.some((message) => message.role === "user")) return undefined;
  return messages;
}

function contentText(result: Awaited<ReturnType<Client["callTool"]>>, chatJwt: string): string {
  const blocks: unknown[] = Array.isArray(result.content) ? result.content : [];
  const text = blocks.flatMap((block) => {
    if (
      typeof block === "object" && block !== null &&
      "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string"
    ) {
      return [block.text];
    }
    return [];
  }).join("\n");
  const safeText = redactSensitiveText(text, chatJwt);
  let safeContent: unknown = safeText;
  try {
    safeContent = redactSensitiveData(JSON.parse(safeText));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    safeContent = safeText;
  }
  return JSON.stringify({ isError: result.isError === true, content: safeContent });
}

function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(?:token|secret|password|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(key)
      ? "[redacted]"
      : redactSensitiveData(entry),
  ]));
}

function redactToolArgs(value: Record<string, unknown>): Record<string, unknown> {
  return redactSensitiveData(value) as Record<string, unknown>;
}

function redactSensitiveText(value: string, chatJwt: string): string {
  return value
    .replaceAll(chatJwt, "[redacted]")
    .replaceAll(configuredApiKey, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\burk_[A-Fa-f0-9]{64}\b/gi, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[redacted]")
    .replace(
      /\b(password|token|secret|credential|authorization|api[_ -]?key)\s*(?:[:=]\s*|\s+is\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    );
}

function systemPrompt(): string {
  const now = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "long",
  });
  return `You are the Urumi MCP gateway assistant. Today is ${now} (Asia/Kolkata).
Be warm, clear, and conversational. Answer the user's question directly, explain results in natural language, and use concise Markdown lists or tables only when they make the answer easier to read. When you use tools, summarize their results rather than repeating raw JSON. Never claim an action succeeded unless the tool result confirms success.
For ANY question about products, orders, or other store data, you MUST call the relevant tool first, even if you answered something similar earlier in this conversation. Never answer store questions from memory. Never claim you called a tool or searched unless you actually called it. When listing products, call list_products with per_page 100 and no search filter unless the user asked to search. Never call create_product more than once for one request.
If a create_product call fails or times out, do not retry it; the product may still have been created. Only report product details returned by tools. When listing products, show each returned product as a separate Markdown table row or bullet, and do not describe products as stray or test products unless a tool result confirms that.
Never output your reasoning or notes in parentheses; reply with the answer only.`;
}

const chatRouter = Router();

chatRouter.post("/chat", requireSession, async (req: Request, res: Response) => {
  const user = res.locals.user as { id: string; email: string };
  const limit = chatRateLimit(user.id);
  if (!limit.allowed) {
    const reason = "Rate limit exceeded for POST /api/chat.";
    await writeAudit({
      userId: user.id,
      actorEmail: user.email,
      source: "chat",
      serverSlug: null,
      tool: null,
      startedAt: new Date(),
      durationMs: 0,
      outcome: "rejected",
      errorMessage: reason,
    });
    res.set("Retry-After", String(limit.retryAfterSeconds)).status(429).json({
      error: `${reason} Retry after ${limit.retryAfterSeconds} seconds.`,
    });
    return;
  }

  const messages = parseMessages(req.body?.messages);
  if (!messages) {
    res.status(400).json({
      error: `messages must contain 1-${maxMessages} user/assistant text messages, each 1-${maxMessageLength} characters, and include a user message.`,
    });
    return;
  }

  const jwt = mintChatJwt(user.id);
  const client = new Client({ name: "urumi-chat-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${jwt}` },
    },
  });
  const toolCalls: ToolCallSummary[] = [];
  let createProductAttempted = false;

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const visibleTools = listed.tools;
    const tools: ChatCompletionTool[] = chatToolMode === "search"
      ? [searchToolsDefinition, callToolDefinition]
      : visibleTools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema as Record<string, unknown>,
          },
      }));
    const conversation: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `${systemPrompt()}${chatToolMode === "search"
          ? "\nIn search mode, use search_tools to find relevant tools, then call them with call_tool using the exact returned name and their required arguments."
          : ""}`,
      },
      ...messages,
    ];

    for (let round = 0; round < maxRounds; round += 1) {
      const completion = await openai.chat.completions.create({
        model,
        max_tokens: 600,
        messages: conversation,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: round === 0 ? "required" : "auto",
      });
      const response = completion.choices[0]?.message;
      if (!response) {
        res.status(502).json({ error: "The chat model returned no response." });
        return;
      }
      if (!response.tool_calls?.length) {
        res.json({
          answer: redactSensitiveText(response.content ?? "", jwt),
          toolCalls,
        });
        return;
      }

      conversation.push(response);
      for (const call of response.tool_calls) {
        if (call.type !== "function") {
          toolCalls.push({ name: call.custom.name, args: {}, durationMs: 0, ok: false });
          conversation.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({ isError: true, content: "Unsupported tool call type." }),
          });
          continue;
        }
        let args: Record<string, unknown> = {};
        let resultText: string;
        let ok = false;
        const started = Date.now();
        let toolName = call.function.name;
        let toolArgs = args;
        let showToolCall = chatToolMode === "all";
        let isCreateProduct = false;
        try {
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("Tool arguments must be a JSON object.");
          }
          args = parsed as Record<string, unknown>;

          if (chatToolMode === "search" && call.function.name === "search_tools") {
            if (typeof args.query !== "string") throw new Error("search_tools query must be a string.");
            resultText = JSON.stringify({
              isError: false,
              content: searchVisibleTools(visibleTools, args.query),
            });
            showToolCall = false;
          } else {
            if (chatToolMode === "search") {
              if (call.function.name !== "call_tool") {
                throw new Error("Only search_tools and call_tool are available in search mode.");
              }
              if (
                typeof args.name !== "string" ||
                typeof args.arguments !== "object" ||
                args.arguments === null ||
                Array.isArray(args.arguments)
              ) {
                throw new Error("call_tool requires a tool name and an arguments object.");
              }
              toolName = args.name;
              toolArgs = args.arguments as Record<string, unknown>;
              showToolCall = true;
            } else {
              toolArgs = args;
            }

            isCreateProduct = toolName === "create_product" || toolName.endsWith("__create_product");
            if (isCreateProduct && createProductAttempted) {
              resultText = JSON.stringify({
                isError: true,
                content: "A create_product call was already attempted for this request; no additional call was made.",
              });
            } else {
              if (isCreateProduct) createProductAttempted = true;
              const result = await client.callTool({ name: toolName, arguments: toolArgs });
              ok = result.isError !== true;
              resultText = contentText(result, jwt);
            }
          }
        } catch {
          resultText = JSON.stringify({
            isError: true,
            content: isCreateProduct && createProductAttempted
              ? "The create_product call failed or timed out. It may still have completed; do not retry it."
              : "Tool call failed.",
          });
        }
        const durationMs = Date.now() - started;
        if (showToolCall) {
          toolCalls.push({
            name: toolName,
            args: redactToolArgs(toolArgs),
            durationMs,
            ok,
          });
        }
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultText,
        });
      }
    }

    res.json({
      answer: redactSensitiveText("I could not produce a final text answer within 8 tool rounds.", jwt),
      toolCalls,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("chat request failed:", redactSensitiveText(errorMessage, jwt));
    res.status(502).json({ error: "The chat request could not be completed." });
  } finally {
    try {
      await client.close();
    } catch {
      console.error("chat MCP client close failed.");
    }
  }
});

export { chatRouter };

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Router, type Request, type Response } from "express";
import { mintChatJwt } from "./chat-jwt.js";
import { requireSession } from "./auth.js";

const model = process.env.LLM_MODEL;
const apiKey = process.env.LLM_API_KEY;
const baseURL = process.env.LLM_BASE_URL;
const mcpUrl = process.env.GATEWAY_MCP_URL ?? "http://gateway:3000/mcp";
const maxRounds = 8;
const maxMessages = 40;
const maxMessageLength = 8_000;

if (!model) throw new Error("LLM_MODEL must be set.");
if (!apiKey) throw new Error("LLM_API_KEY must be set.");
if (!baseURL) throw new Error("LLM_BASE_URL must be set.");
const configuredApiKey: string = apiKey;

const openai = new OpenAI({ apiKey: configuredApiKey, baseURL });

type ChatMessage = { role: "user" | "assistant"; content: string };
type ToolCallSummary = {
  name: string;
  args: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
};

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
  return `You are the Urumi MCP gateway assistant. Today is ${now} (Asia/Kolkata). Use available tools when they help answer the user.`;
}

const chatRouter = Router();

chatRouter.post("/chat", requireSession, async (req: Request, res: Response) => {
  const messages = parseMessages(req.body?.messages);
  if (!messages) {
    res.status(400).json({
      error: `messages must contain 1-${maxMessages} user/assistant text messages, each 1-${maxMessageLength} characters, and include a user message.`,
    });
    return;
  }

  const user = res.locals.user as { id: string };
  const jwt = mintChatJwt(user.id);
  const client = new Client({ name: "urumi-chat-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${jwt}` },
    },
  });
  const toolCalls: ToolCallSummary[] = [];

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools: ChatCompletionTool[] = listed.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    }));
    const conversation: ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt() },
      ...messages,
    ];

    for (let round = 0; round < maxRounds; round += 1) {
      const completion = await openai.chat.completions.create({
        model,
        messages: conversation,
        tools: tools.length > 0 ? tools : undefined,
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
        try {
          const parsed: unknown = JSON.parse(call.function.arguments);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("Tool arguments must be a JSON object.");
          }
          args = parsed as Record<string, unknown>;
          const result = await client.callTool({ name: call.function.name, arguments: args });
          ok = result.isError !== true;
          resultText = contentText(result, jwt);
        } catch {
          resultText = JSON.stringify({ isError: true, content: "Tool call failed." });
        }
        const durationMs = Date.now() - started;
        toolCalls.push({
          name: call.function.name,
          args: redactToolArgs(args),
          durationMs,
          ok,
        });
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

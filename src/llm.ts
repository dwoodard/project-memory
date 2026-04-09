import { readProjectConfig } from "./config.js";
import { findProjectMemoryDir } from "./hook-utils.js";

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

function getProjectMemoryDir(): string {
  const dir = findProjectMemoryDir(process.cwd());
  if (!dir) throw new Error("Not in an initialized project. Run: pensive init");
  return dir;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export interface LLMChatResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason?: string;
}

export async function llmChatMessages(
  messages: ChatMessage[],
  tools?: ToolDefinition[]
): Promise<LLMChatResponse> {
  const config = readProjectConfig(getProjectMemoryDir());
  const { model, baseUrl, apiKey } = config.llm;

  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: 2048,
    temperature: 0.7,
  };
  if (tools && tools.length > 0) {
    body["tools"] = tools;
    body["tool_choice"] = "auto";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as OpenAIResponse;
  const choice = json.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    tool_calls: choice?.message?.tool_calls,
    finish_reason: choice?.finish_reason,
  };
}

export async function llmComplete(prompt: string): Promise<string> {
  const config = readProjectConfig(getProjectMemoryDir());
  const { model, baseUrl, apiKey } = config.llm;

  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
      temperature: 0.2,
    }),
  });

  if (!res.ok) throw new Error(`LLM request failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as OpenAIResponse;
  return json.choices?.[0]?.message?.content ?? "";
}

export async function embed(text: string): Promise<number[]> {
  const config = readProjectConfig(getProjectMemoryDir());
  const { model, baseUrl, apiKey } = config.embedding;

  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/embeddings` : `${base}/v1/embeddings`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) throw new Error(`Embedding request failed (${res.status}): ${await res.text()}`);
  const json = await res.json() as EmbeddingResponse;
  return json.data?.[0]?.embedding ?? [];
}

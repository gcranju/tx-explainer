// Provider-agnostic LLM client with an optional tool-use loop. Works with any
// free OpenAI-compatible provider (Groq, Google Gemini, OpenRouter) or a local
// Ollama (auto-detected, no key); Anthropic is supported as a single-shot fallback.
//
// Config (first match wins):
//   LLM_BASE_URL + LLM_MODEL [+ LLM_API_KEY]  → OpenAI-compatible endpoint (tool-use enabled)
//   ANTHROPIC_API_KEY                          → Claude (single-shot, no tools)
//   (a local Ollama on :11434)                 → auto-detected via its /v1 OpenAI-compatible API
//
// Free quick-starts:
//   Groq:       LLM_BASE_URL=https://api.groq.com/openai/v1   LLM_MODEL=llama-3.3-70b-versatile   LLM_API_KEY=gsk_...
//   Gemini:     LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai  LLM_MODEL=gemini-2.0-flash  LLM_API_KEY=...
//   OpenRouter: LLM_BASE_URL=https://openrouter.ai/api/v1  LLM_MODEL=meta-llama/llama-3.3-70b-instruct:free  LLM_API_KEY=sk-or-...
//   Ollama:     ollama serve && ollama pull llama3.1   (auto-detected)

export interface LlmInfo {
  provider: 'openai-compatible' | 'anthropic' | 'none';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  supportsTools: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: any; // JSON Schema
}
export type ToolExecutor = (name: string, args: any) => Promise<string>;

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const SYSTEM = 'You are a Solidity revert-diagnosis assistant. Use the provided tools to read contract source and on-chain state as needed, then respond with a single JSON object and nothing else.';

let resolved: LlmInfo | undefined;
let lastError: string | undefined;
export function getLastLlmError(): string | undefined { return lastError; }

export async function resolveLlm(): Promise<LlmInfo> {
  if (resolved) return resolved;
  if (process.env.LLM_BASE_URL && process.env.LLM_MODEL) {
    resolved = { provider: 'openai-compatible', baseUrl: process.env.LLM_BASE_URL.replace(/\/$/, ''), model: process.env.LLM_MODEL, apiKey: process.env.LLM_API_KEY, supportsTools: true };
    return resolved;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    resolved = { provider: 'anthropic', model: 'claude-opus-4-8', supportsTools: false };
    return resolved;
  }
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const data: any = await res.json();
      const model = process.env.OLLAMA_MODEL ?? data?.models?.[0]?.name;
      if (model) { resolved = { provider: 'openai-compatible', baseUrl: `${OLLAMA_URL}/v1`, model, supportsTools: true }; return resolved; }
    }
  } catch { /* not running */ }
  resolved = { provider: 'none', supportsTools: false };
  return resolved;
}

function extractJson(text: string): any | null {
  if (!text) return null;
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(fenced.slice(start, end + 1)); } catch { return null; }
}

/**
 * Run a tool-use loop against an OpenAI-compatible endpoint, or a single-shot
 * Anthropic call. Returns the parsed JSON object the model ends with.
 */
export async function llmJson(prompt: string, tools?: ToolSpec[], exec?: ToolExecutor): Promise<{ obj: any; info: LlmInfo } | null> {
  const info = await resolveLlm();
  try {
    if (info.provider === 'openai-compatible') {
      const obj = await openaiAgent(info, prompt, tools, exec);
      return obj ? { obj, info } : null;
    }
    if (info.provider === 'anthropic') {
      const obj = await anthropicChat(info.model!, prompt);
      return obj ? { obj, info } : null;
    }
  } catch {
    return null;
  }
  return null;
}

async function openaiAgent(info: LlmInfo, prompt: string, tools?: ToolSpec[], exec?: ToolExecutor): Promise<any | null> {
  const messages: any[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ];
  const toolDefs = tools?.length
    ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    : undefined;

  for (let iter = 0; iter < 8; iter++) {
    const body: any = { model: info.model, temperature: 0, messages };
    if (toolDefs) { body.tools = toolDefs; body.tool_choice = 'auto'; }
    const res = await fetch(`${info.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(info.apiKey ? { authorization: `Bearer ${info.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      if (process.env.LLM_DEBUG) console.error(`[llm] HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(bodyText)?.error?.message ?? msg; } catch { /* keep */ }
      lastError = res.status === 429 ? `rate limited — ${msg}` : msg;
      // Some providers/models reject tools — retry once without them.
      if (toolDefs && (res.status === 400 || res.status === 404)) return openaiAgentNoTools(info, prompt);
      return null;
    }
    lastError = undefined;
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) { if (process.env.LLM_DEBUG) console.error('[llm] no message in response', JSON.stringify(data).slice(0, 300)); return null; }
    if (process.env.LLM_DEBUG) console.error(`[llm] round content (${(msg.content ?? '').length} chars): ${(msg.content ?? '').slice(0, 240)}`);

    const toolCalls = msg.tool_calls;
    if (toolCalls?.length && exec) {
      messages.push(msg);
      for (const call of toolCalls) {
        let result: string;
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          result = await exec(call.function.name, args);
        } catch (e: any) {
          result = `error: ${e?.message ?? e}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 6000) });
      }
      continue; // let the model use the results
    }
    return extractJson(msg.content ?? '');
  }
  // Ran out of iterations — ask once more for the final JSON.
  messages.push({ role: 'user', content: 'Now give your final answer as a single JSON object.' });
  return openaiFinal(info, messages);
}

async function openaiAgentNoTools(info: LlmInfo, prompt: string): Promise<any | null> {
  return openaiFinal(info, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ]);
}

async function openaiFinal(info: LlmInfo, messages: any[]): Promise<any | null> {
  const res = await fetch(`${info.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(info.apiKey ? { authorization: `Bearer ${info.apiKey}` } : {}) },
    body: JSON.stringify({ model: info.model, temperature: 0, messages }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return extractJson(data?.choices?.[0]?.message?.content ?? '');
}

async function anthropicChat(model: string, prompt: string): Promise<any | null> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const params: any = {
    model,
    max_tokens: 8000,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt + '\n\nRespond with a single JSON object and nothing else.' }],
  };
  const res: any = await client.messages.create(params);
  const text = res.content.find((b: any) => b.type === 'text');
  return extractJson(text?.text ?? '');
}

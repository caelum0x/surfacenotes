// Optional AI narrative pass — OFF by default, never required for surfacenotes to work.
// Research that led to this file (see plans/surfacenotes.md): the dominant failure mode in
// every competing "AI changelog" tool is hallucinated fluff from raw commit diffs/messages
// ("a robust and seamless enhancement to the authentication experience" for a login-redirect
// fix). The fix used here is the same one the research surfaced as best practice: feed the
// model ONLY the already-deduplicated, already-grouped commit bullet text this tool already
// produced — never a raw diff, never an unstructured commit log — so it can rephrase, not invent.
import type { GroupedCommits } from "./types.js";

export interface AiConfig {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";
/** Ollama's OpenAI-compatible endpoint ignores the API key but the SDK/fetch call still needs a non-empty value. */
const OLLAMA_PLACEHOLDER_KEY = "ollama";
/**
 * `generateNarrative` is the one real network call in this whole codebase, and `config.baseUrl`
 * is whatever the user points it at — their own key against the real OpenAI endpoint, a local
 * Ollama instance, or any other self-hosted/corporate OpenAI-compatible proxy. None of those are
 * untrusted in the "attacker-controlled" sense, but all of them are real network calls to a real
 * process outside this one, and the original `fetch` call had no timeout and no cap on how much
 * of the response it would buffer before `res.json()` — a hung/slow endpoint (a local model still
 * loading, a stalled corporate proxy) wedges `generate --ai` forever with no feedback and no way
 * out except Ctrl+C, and a misbehaving endpoint streaming an unbounded body would be buffered into
 * memory in full before any check ran.
 */
const AI_REQUEST_TIMEOUT_MS = 30_000;
/** Far more than any real narrative response needs (a few KB of prose) — guards memory, not correctness. */
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Resolves AI config purely from environment variables the user controls — never a bundled
 * key, never a mandatory SaaS endpoint. Returns null (not a throw) when nothing is configured,
 * so `--ai` always degrades gracefully to the already-complete structured output.
 * `SURFACENOTES_AI_BASE_URL=ollama` is a shorthand for the common local-Ollama case.
 */
export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig | null {
  const rawBaseUrl = env.SURFACENOTES_AI_BASE_URL ?? env.OPENAI_BASE_URL;
  const apiKey = env.SURFACENOTES_AI_API_KEY ?? env.OPENAI_API_KEY;
  const model = env.SURFACENOTES_AI_MODEL ?? DEFAULT_MODEL;

  if (rawBaseUrl === "ollama") {
    return { baseUrl: "http://localhost:11434/v1", apiKey: OLLAMA_PLACEHOLDER_KEY, model: env.SURFACENOTES_AI_MODEL ?? "llama3.1" };
  }
  if (rawBaseUrl && apiKey) {
    return { baseUrl: rawBaseUrl, apiKey, model };
  }
  // Plain OpenAI: a key alone is enough, default to the real public base URL.
  if (!rawBaseUrl && apiKey) {
    return { baseUrl: "https://api.openai.com/v1", apiKey, model };
  }
  return null;
}

function bulletsFromGroups(groups: GroupedCommits): string[] {
  const bullets = [...groups.breakingDeclared, ...groups.feat, ...groups.fix, ...groups.changed]
    .map((c) => c.description.trim())
    .filter((d) => d.length > 0);
  // Dedupe identical descriptions (common after a squash-merge chain touches the same bullet twice).
  return Array.from(new Set(bullets));
}

const SYSTEM_PROMPT =
  "You write short, factual release-note summaries for software developers. " +
  "You will be given a plain bullet list already extracted from real commit messages — " +
  "nothing else. Rephrase it into 2-4 plain sentences a developer would read before upgrading. " +
  "Never invent a feature, fix, or detail that is not already in the bullet list. " +
  "Never use marketing language ('seamless', 'robust', 'powerful', 'game-changing'). " +
  "If the bullet list is empty or trivial, say so in one short sentence instead of padding it.";

/**
 * Reads a fetch `Response` body as text, aborting once more than `maxBytes` has arrived instead
 * of letting an unbounded stream buffer fully into memory before any size check runs (which is
 * what a bare `await res.json()`/`await res.text()` does). Falls back to `res.text()` for a
 * `Response` with no readable stream body (e.g. a test double), since there's nothing to cap.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(`response exceeded ${maxBytes} byte limit`);
        throw new Error(`AI response exceeded the ${maxBytes}-byte limit — aborted before buffering it fully`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/**
 * Calls an OpenAI-compatible chat completions endpoint with ONLY the deduplicated bullet text
 * this tool already extracted — never the raw commit log, never source diffs. Returns null (not
 * a throw) on any network/API failure, timeout, or oversized response so a flaky or misbehaving
 * AI call never hangs or breaks changelog generation; the caller always still has the complete,
 * verified structured output without it.
 */
export async function generateNarrative(groups: GroupedCommits, config: AiConfig): Promise<string | null> {
  const bullets = bulletsFromGroups(groups);
  if (bullets.length === 0) return null;

  const userContent = bullets.map((b) => `- ${b}`).join("\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[surfacenotes] AI narrative request failed: ${res.status} ${res.statusText} — skipping, structured output is unaffected`);
      return null;
    }
    const bodyText = await readBodyCapped(res, AI_MAX_RESPONSE_BYTES);
    const json = JSON.parse(bodyText) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const detail = isTimeout ? `timed out after ${AI_REQUEST_TIMEOUT_MS}ms` : err instanceof Error ? err.message : String(err);
    console.error(`[surfacenotes] AI narrative request ${detail} — skipping, structured output is unaffected`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

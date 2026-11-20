import "server-only";
import { gradingResponseSchema, type GradingInput, type GradingResponse } from "./schema";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

const DEFAULT_MODEL = "gpt-4o-mini";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export type GradingFailure =
  | "config"
  | "rateLimited"
  | "timeout"
  | "api"
  | "invalid";

export class GradingError extends Error {
  code: GradingFailure;

  constructor(code: GradingFailure, message: string) {
    super(message);
    this.name = "GradingError";
    this.code = code;
  }
}

export type ProviderConfig = {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  mock: boolean;
};

export function providerConfig(): ProviderConfig {
  const apiKey = (process.env.AI_API_KEY ?? "").trim();
  const baseUrl = (process.env.AI_BASE_URL ?? "").trim();
  const model = (process.env.AI_MODEL ?? "").trim() || DEFAULT_MODEL;
  const mock =
    !apiKey &&
    process.env.AI_MOCK === "1" &&
    process.env.NODE_ENV !== "production";

  return {
    apiKey: apiKey || null,
    baseUrl: baseUrl || null,
    model: mock ? "mock" : model,
    mock,
  };
}

export function isGradingConfigured(): boolean {
  const config = providerConfig();
  return Boolean(config.apiKey) || config.mock;
}

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: {
      type: "NUMBER",
      description: "Numeric score between 0 and the assignment maximum.",
    },
    feedback_en: {
      type: "STRING",
      description: "Short English feedback a first-year student can act on.",
    },
    feedback_ar: {
      type: "STRING",
      description: "The same feedback written in Arabic.",
    },
    issues: {
      type: "ARRAY",
      description: "Concrete problems to fix, newest rubric order, max 6.",
      items: { type: "STRING" },
    },
  },
  required: ["score", "feedback_en", "feedback_ar", "issues"],
  propertyOrdering: ["score", "feedback_en", "feedback_ar", "issues"],
} as const;

type OpenAICompatiblePayload = {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; code?: string };
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(10_000, retryAfter * 1_000);
  }
  const base = 1_000 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 500);
}

function extractText(payload: OpenAICompatiblePayload): string {
  if (payload.error?.message) {
    throw new GradingError("api", payload.error.message);
  }

  const choice = payload.choices?.[0];
  if (!choice) throw new GradingError("invalid", "Empty grading response.");

  if (choice.finish_reason === "length") {
    throw new GradingError("invalid", "Grading response was truncated.");
  }

  const text = choice.message?.content?.trim();
  if (!text) throw new GradingError("invalid", "Empty grading response.");
  return text;
}

function parseGradingJson(text: string, maxScore: number): GradingResponse {
  const cleaned = text
    .replace(/^\uFEFF/, "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    throw new GradingError("invalid", "The grader did not return JSON.");
  }

  const parsed = gradingResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GradingError("invalid", "The grader returned an unexpected shape.");
  }

  const score = Math.max(0, Math.min(maxScore, Math.round(parsed.data.score * 10) / 10));

  return {
    score: Number.isFinite(score) ? score : 0,
    feedback_en: parsed.data.feedback_en,
    feedback_ar: parsed.data.feedback_ar,
    issues: parsed.data.issues.slice(0, 6),
  };
}

export type GradeCodeResult = {
  response: GradingResponse;
  model: string;
  mock: boolean;
};

/**
 * Calls an OpenAI-compatible API with a strict JSON response schema and retries transient
 * failures (429/5xx/network). The API key never leaves the server.
 */
export async function gradeCode(
  input: GradingInput,
  options: { maxAttempts?: number } = {},
): Promise<GradeCodeResult> {
  const config = providerConfig();

  if (config.mock) {
    const { mockGrade } = await import("./mock");
    return { response: mockGrade(input), model: "mock", mock: true };
  }

  if (!config.apiKey) {
    throw new GradingError("config", "AI_API_KEY is not configured.");
  }

  if (!config.baseUrl) {
    throw new GradingError("config", "AI_BASE_URL is not configured.");
  }

  const maxAttempts = Math.min(
    MAX_ATTEMPTS,
    Math.max(1, options.maxAttempts ?? MAX_ATTEMPTS),
  );

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });

  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

  let lastFailure: GradingError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });

      if (response.ok) {
        const payload = (await response.json()) as OpenAICompatiblePayload;
        const text = extractText(payload);
        return {
          response: parseGradingJson(text, input.maxScore),
          model: config.model,
          mock: false,
        };
      }

      const status = response.status;
      console.error(`AI grading failed with status ${status} (attempt ${attempt}).`);

      if (status === 429) {
        lastFailure = new GradingError("rateLimited", "AI provider rate limit reached.");
      } else if (status === 401 || status === 403) {
        throw new GradingError("config", "AI provider rejected the API key.");
      } else if (status === 400) {
        throw new GradingError("api", "AI provider rejected the request.");
      } else {
        lastFailure = new GradingError("api", `AI provider returned ${status}.`);
      }

      if (!RETRYABLE_STATUS.has(status) || attempt === maxAttempts) {
        throw lastFailure;
      }

      await sleep(backoffMs(attempt, response.headers.get("retry-after")));
    } catch (error) {
      if (error instanceof GradingError) throw error;

      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");

      lastFailure = isTimeout
        ? new GradingError("timeout", "AI provider did not answer in time.")
        : new GradingError("api", "Could not reach AI provider.");

      console.error(
        `AI grading request error (attempt ${attempt}):`,
        error instanceof Error ? error.message : error,
      );

      if (attempt === maxAttempts) throw lastFailure;
      await sleep(backoffMs(attempt, null));
    }
  }

  throw lastFailure ?? new GradingError("api", "Grading failed.");
}
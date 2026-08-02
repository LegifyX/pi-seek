import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  BASE_URL,
  PROVIDER_ID,
  resolveTimeoutMs,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Authentication and HTTP client
// ---------------------------------------------------------------------------

interface AuthService {
  resolveApiKey: () => Promise<string>;
}

// models.json may hold a `${NAME}` placeholder instead of a literal key; the
// README documents `${DEEPSEEK_API_KEY}` as valid, so resolve such values
// against process.env before use.
const ENV_PLACEHOLDER_REGEX = /^\$\{([A-Z][A-Z0-9_]*)\}$/;

export const interpolateEnv = (value: string): string | undefined => {
  const match = ENV_PLACEHOLDER_REGEX.exec(value);
  if (!match) {
    return value;
  }
  return process.env[match[1]]?.trim() || undefined;
};

export const createAuthService = (deps?: {
  agentDir?: string;
  readFile?: (path: string) => Promise<string>;
}): AuthService => {
  const agentDir = deps?.agentDir ?? getAgentDir();
  const readConfigFile =
    deps?.readFile ?? ((path: string) => readFile(path, "utf8"));
  let cachedKey: string | undefined;

  const resolveApiKey = async (): Promise<string> => {
    if (cachedKey) {
      return cachedKey;
    }

    const environmentKey = process.env[API_KEY_ENV]?.trim();
    if (environmentKey) {
      cachedKey = environmentKey;
      return environmentKey;
    }

    try {
      const rawConfig = await readConfigFile(join(agentDir, "models.json"));
      const config = JSON.parse(rawConfig) as {
        providers?: Record<string, { apiKey?: string }>;
      };
      const configuredKey = config.providers?.[PROVIDER_ID]?.apiKey?.trim();
      if (configuredKey) {
        const interpolated = interpolateEnv(configuredKey);
        if (interpolated) {
          cachedKey = interpolated;
          return interpolated;
        }
      }
    } catch {
      // The error below gives the user both supported key locations.
    }

    throw new Error(
      `DeepSeek API key not found: set ${API_KEY_ENV} (or configure an apiKey for the "${PROVIDER_ID}" provider in models.json).`
    );
  };

  return { resolveApiKey };
};

export interface HttpClient {
  getJson: (
    path: string,
    signal?: AbortSignal,
    baseUrl?: string
  ) => Promise<unknown>;
  postJson: (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    baseUrl?: string
  ) => Promise<unknown>;
}

const getErrorName = (error: unknown): string | undefined =>
  error instanceof Error ? error.name : undefined;

const RETRY_AFTER_SECONDS_PATTERN = /^\d+$/;

// Retry-After may be a delta-seconds integer or an HTTP-date; the hint is
// bounded and appended to the error string when present.
const formatRetryAfterHint = (retryAfter: string | null): string => {
  if (!retryAfter) {
    return "";
  }
  const suffix = RETRY_AFTER_SECONDS_PATTERN.test(retryAfter) ? "s" : "";
  return ` (retry after ${retryAfter}${suffix})`;
};

const throwHttpError = async (response: Response): Promise<never> => {
  const detail = await response.text().catch(() => "");
  throw new Error(
    `DeepSeek API ${response.status}: ${detail.slice(0, 400)}${formatRetryAfterHint(response.headers.get("retry-after"))}`
  );
};

export const createHttpClient = (auth: AuthService): HttpClient => {
  const getJson = async (
    path: string,
    signal?: AbortSignal,
    baseUrl = BASE_URL
  ): Promise<unknown> => {
    const key = await auth.resolveApiKey();
    const timeoutSignal = AbortSignal.timeout(resolveTimeoutMs(undefined));
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${key}`,
        },
        method: "GET",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Aborted by user", { cause: error });
      }
      const errorName = getErrorName(error);
      if (errorName === "TimeoutError" || errorName === "AbortError") {
        throw new Error("DeepSeek request timed out", { cause: error });
      }
      throw error;
    }

    if (!response.ok) {
      await throwHttpError(response);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error("DeepSeek API returned an invalid JSON response", {
        cause: error,
      });
    }
  };

  const postJson = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
    baseUrl = BASE_URL
  ): Promise<unknown> => {
    const key = await auth.resolveApiKey();
    const timeoutSignal = AbortSignal.timeout(resolveTimeoutMs(body));
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: requestSignal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Aborted by user", { cause: error });
      }
      const errorName = getErrorName(error);
      if (errorName === "TimeoutError" || errorName === "AbortError") {
        throw new Error("DeepSeek request timed out", { cause: error });
      }
      throw error;
    }

    if (!response.ok) {
      await throwHttpError(response);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error("DeepSeek API returned an invalid JSON response", {
        cause: error,
      });
    }
  };

  return { getJson, postJson };
};

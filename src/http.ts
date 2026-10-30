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

// pi keeps provider credentials in <agentDir>/auth.json as
// { "<provider>": { "type": "api_key", "key": "sk-..." } }. pi-seek registers
// the "deepseek-responses" provider, but the same account is usually logged in
// as pi's built-in "deepseek" provider, so that id is accepted too.
const AUTH_PROVIDER_IDS = [PROVIDER_ID, "deepseek"] as const;

interface AuthFileEntry {
  key?: unknown;
}

const readKeyFromAuthFile = async (
  readAuthFile: (path: string) => Promise<string>,
  agentDir: string
): Promise<string | undefined> => {
  let raw: string | undefined;
  try {
    raw = await readAuthFile(join(agentDir, "auth.json"));
  } catch {
    // A missing or unreadable auth.json falls through to the guidance error.
    return;
  }
  if (!raw) {
    return;
  }
  let authFile: Record<string, AuthFileEntry>;
  try {
    authFile = JSON.parse(raw) as Record<string, AuthFileEntry>;
  } catch {
    return;
  }
  for (const providerId of AUTH_PROVIDER_IDS) {
    const key = authFile[providerId]?.key;
    if (typeof key === "string" && key.trim()) {
      return key.trim();
    }
  }
};

export const createAuthService = (deps?: {
  agentDir?: string;
  readFile?: (path: string) => Promise<string>;
}): AuthService => {
  const agentDir = deps?.agentDir ?? getAgentDir();
  const readAuthFile =
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

    const authKey = await readKeyFromAuthFile(readAuthFile, agentDir);
    if (authKey) {
      cachedKey = authKey;
      return authKey;
    }

    throw new Error(
      `DeepSeek API key not found: set ${API_KEY_ENV}, or sign in with pi so ${join(agentDir, "auth.json")} holds an API key for the "${PROVIDER_ID}" or "deepseek" provider.`
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

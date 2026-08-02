import { BETA_URL, getArray, isJsonObject, type JsonObject } from "./config.ts";
import type { HttpClient } from "./http.ts";

// ---------------------------------------------------------------------------
// Beta API service
// ---------------------------------------------------------------------------

export interface BetaApi {
  postChatCompletion: (
    body: JsonObject,
    signal?: AbortSignal
  ) => Promise<JsonObject>;
  postCompletion: (
    body: JsonObject,
    signal?: AbortSignal
  ) => Promise<JsonObject>;
}

export const createBetaApi = (http: HttpClient): BetaApi => {
  const post = async (
    path: string,
    body: JsonObject,
    signal?: AbortSignal
  ): Promise<JsonObject> => {
    const response = await http.postJson(path, body, signal, BETA_URL);
    return isJsonObject(response) ? response : {};
  };

  return {
    postChatCompletion: async (body, signal) =>
      await post("/chat/completions", body, signal),
    postCompletion: async (body, signal) =>
      await post("/completions", body, signal),
  };
};

export const getFirstChoice = (
  response: JsonObject
): JsonObject | undefined => {
  const [firstChoice] = getArray(response, "choices");
  return isJsonObject(firstChoice) ? firstChoice : undefined;
};

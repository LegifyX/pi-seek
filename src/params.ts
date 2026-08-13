import { Type } from "typebox";
import { MAX_OUTPUT_TOKENS } from "./config.ts";

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const EffortParam = Type.Optional(
  Type.Union(
    [
      Type.Literal("none"),
      Type.Literal("minimal"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
      Type.Literal("max"),
    ],
    {
      description:
        "Reasoning effort for this call (documented Responses values: none, minimal, low, medium, high, xhigh, max)",
    }
  )
);

export const ChatParams = Type.Object({
  format: Type.Optional(
    Type.Union(
      [
        Type.Literal("text"),
        Type.Literal("json_object"),
        Type.Literal("json_schema"),
      ],
      {
        description:
          "Structured-output format for the reply (text, json_object, or json_schema)",
      }
    )
  ),
  json_schema: Type.Optional(
    Type.Any({
      description:
        "JSON schema for json_schema output; normalized to DeepSeek's strict-mode dialect",
    })
  ),
  max_output_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum output tokens for this round",
      maximum: MAX_OUTPUT_TOKENS,
      minimum: 16,
    })
  ),
  message: Type.String({ description: "The user message to send to DeepSeek" }),
  reasoning_effort: EffortParam,
  system: Type.Optional(
    Type.String({
      description:
        "System prompt for a NEW thread; ignored when the thread already exists",
    })
  ),
  temperature: Type.Optional(
    Type.Number({
      description:
        "Sampling temperature (0-2, default 1). No effect while reasoning_effort is not none.",
      maximum: 2,
      minimum: 0,
    })
  ),
  thread: Type.String({
    description:
      "Name of the conversation thread to continue (created on first use)",
  }),
  top_p: Type.Optional(
    Type.Number({
      description:
        "Nucleus sampling (0-1, default 1). No effect while reasoning_effort is not none.",
      maximum: 1,
      minimum: 0,
    })
  ),
});

export const ChatResetParams = Type.Object({
  thread: Type.Optional(
    Type.String({ description: "Thread to reset; omit to reset all threads" })
  ),
});

// Beta surfaces (chat prefix completion, FIM) share documented sampling and
// stop controls (create-completion / chat-completions references).
const StopParam = Type.Optional(
  Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 16 })], {
    description:
      "Stop sequence, or up to 16 sequences where generation ends; the stop text is not included in the result",
  })
);

const TemperatureParam = Type.Optional(
  Type.Number({
    description: "Sampling temperature (0-2, default 1)",
    maximum: 2,
    minimum: 0,
  })
);

const TopPParam = Type.Optional(
  Type.Number({
    description: "Nucleus sampling (0-1, default 1)",
    maximum: 1,
    minimum: 0,
  })
);

export const PrefixParams = Type.Object({
  max_tokens: Type.Optional(
    Type.Integer({
      description:
        "Maximum tokens for the completion (up to the model's 384K output limit)",
      maximum: MAX_OUTPUT_TOKENS,
      minimum: 1,
    })
  ),
  prefix: Type.String({
    description:
      'Assistant prefix the model continues from, e.g. "```python\\n"',
  }),
  prompt: Type.String({
    description: 'User instruction, e.g. "Please write quick sort code"',
  }),
  stop: StopParam,
  temperature: TemperatureParam,
  top_p: TopPParam,
});

export const FimParams = Type.Object({
  logprobs: Type.Optional(
    Type.Integer({
      description:
        "Return the logprobs for the N most likely output tokens (max 20)",
      maximum: 20,
      minimum: 0,
    })
  ),
  max_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum tokens (FIM cap is 4K)",
      maximum: 4096,
      minimum: 1,
    })
  ),
  prompt: Type.String({ description: "Code before the gap to fill" }),
  stop: StopParam,
  suffix: Type.Optional(
    Type.String({ description: "Code after the gap (optional)" })
  ),
  temperature: TemperatureParam,
  top_p: TopPParam,
});

export const WebSearchParams = Type.Object({
  max_output_tokens: Type.Optional(
    Type.Integer({ maximum: MAX_OUTPUT_TOKENS, minimum: 16 })
  ),
  query: Type.String({ description: "The search query" }),
  reasoning_effort: EffortParam,
});

export const CallFunctionParams = Type.Object({
  context: Type.Optional(
    Type.String({
      description:
        "Context the model uses to decide the arguments (the 'user' turn)",
    })
  ),
  description: Type.Optional(
    Type.String({ description: "What the function does" })
  ),
  name: Type.String({
    description:
      "Name of the function the model should call. Must be nonempty, alphanumeric/underscore/hyphen, and at most 64 characters (beta chat-completions surface limit).",
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-zA-Z0-9_-]+$",
  }),
  parameters: Type.Any({
    description:
      "JSON schema for the function parameters. Accepts a TypeBox-style object schema or plain JSON Schema; it is normalized to DeepSeek's strict-mode dialect.",
  }),
});

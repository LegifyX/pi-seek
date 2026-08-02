import { Type } from "typebox";
import { MAX_OUTPUT_TOKENS } from "./config.ts";

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const EffortParam = Type.Optional(
  Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("max")], {
    description: "Reasoning effort for this call",
  })
);

export const ChatParams = Type.Object({
  max_output_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum output tokens for this round",
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
  thread: Type.String({
    description:
      "Name of the conversation thread to continue (created on first use)",
  }),
});

export const ChatResetParams = Type.Object({
  thread: Type.Optional(
    Type.String({ description: "Thread to reset; omit to reset all threads" })
  ),
});

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
  stop: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Stop sequences, e.g. ["```"]',
    })
  ),
});

export const FimParams = Type.Object({
  max_tokens: Type.Optional(
    Type.Integer({
      description: "Maximum tokens (FIM cap is 4K)",
      maximum: 4096,
      minimum: 1,
    })
  ),
  prompt: Type.String({ description: "Code before the gap to fill" }),
  stop: Type.Optional(
    Type.Array(Type.String(), { description: "Stop sequences" })
  ),
  suffix: Type.Optional(
    Type.String({ description: "Code after the gap (optional)" })
  ),
});

export const WebSearchParams = Type.Object({
  max_output_tokens: Type.Optional(Type.Integer({ minimum: 16 })),
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
    description: "Name of the function the model should call",
  }),
  parameters: Type.Any({
    description:
      "JSON schema for the function parameters. Accepts a TypeBox-style object schema or plain JSON Schema; it is normalized to DeepSeek's strict-mode dialect.",
  }),
});

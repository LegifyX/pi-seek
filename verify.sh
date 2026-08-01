#!/usr/bin/env bash
# Live verification for the DeepSeek V4 Flash pi extension.
# Uses $DEEPSEEK_API_KEY if set, else the key configured in models.json.
set -euo pipefail
cd "$(dirname "$0")"

AGENT_DIR="${SENPI_AGENT_DIR:-$HOME/.senpi/agent}"
KEY="${DEEPSEEK_API_KEY:-$(node -e "const c=require('$AGENT_DIR/models.json');process.stdout.write(c.providers['deepseek-responses'].apiKey||'')" 2>/dev/null || true)}"
if [ -z "$KEY" ]; then
  echo "No API key (set DEEPSEEK_API_KEY or configure models.json). Conformance-only check."
  exit 0
fi
export DEEPSEEK_API_KEY="$KEY"
PI_BIN="$(command -v pi)"

echo "== 1. list models =="
"$PI_BIN" --list-models | grep -i deepseek || true

echo "== 2. one-shot chat (print mode) =="
"$PI_BIN" -p "Reply with exactly: PONG" --provider deepseek-responses --model deepseek-v4-flash 2>&1 | tail -3

echo "== 3. extension-only tool surface =="
"$PI_BIN" -p "Use ds_prefix_complete with prompt 'Please write quick sort code' and prefix '\`\`\`python\n' and stop ['\`\`\`']" \
  --no-builtin-tools -t ds_chat,ds_chat_reset,ds_prefix_complete,ds_fim,ds_web_search,ds_call_function \
  --provider deepseek-responses --model deepseek-v4-flash --thinking high 2>&1 | tail -4

#!/usr/bin/env bash
#
# config-gen.sh — interactive setup dialog that generates config.json.
# agent-remote keeps all configuration in config.json (gitignored); no env vars.

set -euo pipefail

CONFIG_FILE="config.json"

# --- helpers ---------------------------------------------------------------

# ask_yn "Question?" default(y|n) -> echoes "true" or "false"
ask_yn() {
  local prompt="$1" default="$2" reply
  local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
  read -r -p "$prompt $hint " reply || true
  reply="${reply:-$default}"
  case "$reply" in
    [Yy]*) echo "true" ;;
    *)     echo "false" ;;
  esac
}

# ask "Question?" default -> echoes answer (or default if empty)
ask() {
  local prompt="$1" default="$2" reply
  read -r -p "$prompt [$default] " reply || true
  echo "${reply:-$default}"
}

# json_escape <string> -> escapes for embedding in a JSON string
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# --- guard against clobbering ----------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
  overwrite="$(ask_yn "$CONFIG_FILE already exists. Overwrite?" "n")"
  [ "$overwrite" = "true" ] || { echo "Aborted; existing $CONFIG_FILE kept."; exit 0; }
fi

echo "agent-remote setup — writing $CONFIG_FILE"
echo

# --- harnesses -------------------------------------------------------------

CLAUDE_ENABLED="$(ask_yn "Expose Claude Code?" "y")"
CLAUDE_COMMAND="claude"
if [ "$CLAUDE_ENABLED" = "true" ]; then
  CLAUDE_COMMAND="$(ask "  Command to launch Claude Code" "claude")"
fi

PI_ENABLED="$(ask_yn "Expose pi?" "y")"
PI_COMMAND="pi"
if [ "$PI_ENABLED" = "true" ]; then
  PI_COMMAND="$(ask "  Command to launch pi" "pi")"
fi

# --- LLM provider ----------------------------------------------------------

echo
echo "Select LLM provider for convenience features:"
echo "  1) llama.cpp"
echo "  2) vLLM"
provider=""
while [ -z "$provider" ]; do
  choice="$(ask "Provider" "1")"
  case "$choice" in
    1|llama.cpp) provider="llama.cpp"; default_url="http://localhost:8080/v1" ;;
    2|vLLM|vllm) provider="vLLM";      default_url="http://localhost:8000/v1" ;;
    *) echo "  Please enter 1 or 2." ;;
  esac
done

LLM_BASE_URL="$(ask "  $provider base URL (OpenAI-compatible)" "$default_url")"
LLM_MODEL="$(ask "  Model name" "")"

# --- write config.json -----------------------------------------------------

cat > "$CONFIG_FILE" <<EOF
{
  "harnesses": {
    "claude": {
      "enabled": $CLAUDE_ENABLED,
      "command": "$(json_escape "$CLAUDE_COMMAND")"
    },
    "pi": {
      "enabled": $PI_ENABLED,
      "command": "$(json_escape "$PI_COMMAND")"
    }
  },
  "llm": {
    "provider": "$(json_escape "$provider")",
    "baseUrl": "$(json_escape "$LLM_BASE_URL")",
    "model": "$(json_escape "$LLM_MODEL")"
  }
}
EOF

echo
echo "Wrote $CONFIG_FILE."

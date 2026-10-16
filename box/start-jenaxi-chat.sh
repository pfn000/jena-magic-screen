#!/usr/bin/env bash
# Production launcher for the larger JenaXI-chat model.
# The default Qwen2.5-1.5B context ceiling is 32K per request; two slots allow two requests.
set -euo pipefail

GGUF="${JENA_CHAT_GGUF:-/models/JenaXI-chat.gguf}"
if [[ ! -f "$GGUF" ]]; then
  echo "No $GGUF mounted; waiting for the model file." >&2
  sleep 3600
  exit 1
fi

export GGUF
export LLAMA_SERVER="${JENA_LLAMA_SERVER:-/opt/llama/llama-server}"
export MODEL_ALIAS="${JENA_CHAT_ALIAS:-JenaXI-chat}"
export HOST="${JENA_CHAT_HOST:-127.0.0.1}"
export PORT="${JENA_CHAT_PORT:-8091}"
export CTX="${JENA_CHAT_CTX_TOTAL:-65536}"
export CTX_PER_SLOT="${JENA_CHAT_CTX_PER_SLOT:-32768}"
export PARALLEL="${JENA_CHAT_PARALLEL:-2}"
export THREADS="${JENA_CHAT_THREADS:-3}"
export THREADS_BATCH="${JENA_CHAT_THREADS_BATCH:-3}"
export BATCH_SIZE="${JENA_CHAT_BATCH:-512}"
export UBATCH_SIZE="${JENA_CHAT_UBATCH:-128}"
export CACHE_TYPE_K="${JENA_KV_CACHE_K:-q8_0}"
export CACHE_TYPE_V="${JENA_KV_CACHE_V:-q8_0}"
export FLASH_ATTN="${JENA_FLASH_ATTN:-on}"
export SPEC_TYPE="${JENA_SPEC_TYPE:-ngram-mod}"
export SPEC_NGRAM_MATCH="${JENA_SPEC_NGRAM_MATCH:-24}"
export SPEC_NGRAM_MIN="${JENA_SPEC_NGRAM_MIN:-48}"
export SPEC_NGRAM_MAX="${JENA_SPEC_NGRAM_MAX:-64}"
export JINJA="${JENA_JINJA:-1}"

exec /bin/bash /opt/jena-repo/box/llama-server-tuned.sh

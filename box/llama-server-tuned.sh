#!/usr/bin/env bash
# Shared, configurable llama.cpp launcher for JenaXI.
# CTX_PER_SLOT uses llama.cpp's explicit per-slot KV budget when supported.
set -euo pipefail

: "${GGUF:?Set GGUF to the model GGUF file}"
[[ -f "$GGUF" ]] || { printf 'Model file not found: %s\n' "$GGUF" >&2; exit 2; }
LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"
if [[ "$LLAMA_SERVER" == */* ]]; then
  [[ -x "$LLAMA_SERVER" ]] || { printf 'llama-server is not executable: %s\n' "$LLAMA_SERVER" >&2; exit 2; }
else
  command -v "$LLAMA_SERVER" >/dev/null 2>&1 || { echo 'llama-server was not found on PATH' >&2; exit 127; }
fi

CPU_COUNT="$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '4')"
MODEL_ALIAS="${MODEL_ALIAS:-JenaXI}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8088}"
CTX="${CTX:-16384}"
CTX_PER_SLOT="${CTX_PER_SLOT:-}"
PARALLEL="${PARALLEL:-1}"
THREADS="${THREADS:-$CPU_COUNT}"
THREADS_BATCH="${THREADS_BATCH:-$THREADS}"
BATCH_SIZE="${BATCH_SIZE:-512}"
UBATCH_SIZE="${UBATCH_SIZE:-128}"
CACHE_TYPE_K="${CACHE_TYPE_K:-q8_0}"
CACHE_TYPE_V="${CACHE_TYPE_V:-q8_0}"
FLASH_ATTN="${FLASH_ATTN:-on}"
SPEC_TYPE="${SPEC_TYPE:-ngram-mod}"
SPEC_NGRAM_MATCH="${SPEC_NGRAM_MATCH:-24}"
SPEC_NGRAM_MIN="${SPEC_NGRAM_MIN:-48}"
SPEC_NGRAM_MAX="${SPEC_NGRAM_MAX:-64}"
JINJA="${JINJA:-1}"

for name in PORT CTX PARALLEL THREADS THREADS_BATCH BATCH_SIZE UBATCH_SIZE SPEC_NGRAM_MATCH SPEC_NGRAM_MIN SPEC_NGRAM_MAX; do
  value="${!name}"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { printf '%s must be a positive integer (got %q)\n' "$name" "$value" >&2; exit 2; }
done
[[ "$FLASH_ATTN" == on || "$FLASH_ATTN" == off || "$FLASH_ATTN" == auto ]] || { echo "FLASH_ATTN must be on, off, or auto" >&2; exit 2; }
if [[ -n "$CTX_PER_SLOT" && ! "$CTX_PER_SLOT" =~ ^[1-9][0-9]*$ ]]; then echo "CTX_PER_SLOT must be a positive integer" >&2; exit 2; fi

HELP="$("$LLAMA_SERVER" --help 2>&1 || true)"
has_option() { grep -Fq -- "$1" <<<"$HELP"; }
ARGS=(-m "$GGUF" --alias "$MODEL_ALIAS" --host "$HOST" --port "$PORT" -np "$PARALLEL" -t "$THREADS")
if [[ -n "$CTX_PER_SLOT" ]] && has_option "--kv-unified-per-slot"; then
  ARGS+=(--kv-unified-per-slot "$CTX_PER_SLOT")
  CTX_LABEL="per-slot=$CTX_PER_SLOT"
else
  ARGS+=(-c "$CTX")
  CTX_LABEL="pool=$CTX"
fi
has_option '--threads-batch' && ARGS+=(-tb "$THREADS_BATCH")
has_option '--batch-size' && ARGS+=(-b "$BATCH_SIZE")
has_option '--ubatch-size' && ARGS+=(-ub "$UBATCH_SIZE")

if has_option '--flash-attn'; then ARGS+=(--flash-attn "$FLASH_ATTN"); fi
if has_option '--cache-type-k'; then ARGS+=(--cache-type-k "$CACHE_TYPE_K"); fi
if has_option '--cache-type-v'; then ARGS+=(--cache-type-v "$CACHE_TYPE_V"); fi
if [[ "$SPEC_TYPE" != none ]] && has_option '--spec-type'; then
  ARGS+=(--spec-type "$SPEC_TYPE")
  if [[ "$SPEC_TYPE" == ngram-mod ]]; then
    has_option '--spec-ngram-mod-n-match' && ARGS+=(--spec-ngram-mod-n-match "$SPEC_NGRAM_MATCH")
    has_option '--spec-ngram-mod-n-min' && ARGS+=(--spec-ngram-mod-n-min "$SPEC_NGRAM_MIN")
    has_option '--spec-ngram-mod-n-max' && ARGS+=(--spec-ngram-mod-n-max "$SPEC_NGRAM_MAX")
  fi
fi
if [[ "$JINJA" == 1 ]] && has_option '--jinja'; then ARGS+=(--jinja); fi

printf 'Starting %s on %s:%s | ctx-size-option=%s | ctx-per-slot-option=%s | slots=%s | threads=%s | KV=%s/%s | flash-attn=%s | speculative=%s\n' "$MODEL_ALIAS" "$HOST" "$PORT" "$CTX" "$CTX_PER_SLOT" "$PARALLEL" "$THREADS" "$CACHE_TYPE_K" "$CACHE_TYPE_V" "$FLASH_ATTN" "$SPEC_TYPE" >&2
exec "$LLAMA_SERVER" "${ARGS[@]}"

#!/usr/bin/env bash
# JenaXI brain: serve her own .gguf model with llama.cpp's llama-server (OpenAI-compatible API, CPU is fine
# for small quantized models) and expose it through a cloudflared quick tunnel.
#
#   GGUF=/path/to/jenaxi.Q4_K_M.gguf ./box/start-jenaxi.sh
#
# Then set on the Vercel project:  JENA_LLM_BASE_URL=https://<printed-tunnel>/v1   (and JENA_LLM_API_KEY if you set one below)
# Install llama.cpp:  https://github.com/ggml-org/llama.cpp  (prebuilt release binaries, or `cmake -B build && cmake --build build -j`)
set -euo pipefail
: "${GGUF:?set GGUF to the JenaXI .gguf file}"
PORT="${PORT:-8080}"; LOG="${LOG:-/tmp/jenaxi}"; mkdir -p "$LOG"
ARGS=(-m "$GGUF" --host 127.0.0.1 --port "$PORT" -c "${CTX:-4096}" -t "${THREADS:-$(nproc)}" --alias jenaxi)
[ -n "${JENA_LLM_API_KEY:-}" ] && ARGS+=(--api-key "$JENA_LLM_API_KEY")
setsid nohup llama-server "${ARGS[@]}" >"$LOG/llama-server.log" 2>&1 &
for i in $(seq 120); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
setsid nohup cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" >"$LOG/cloudflared.log" 2>&1 &
for i in $(seq 60); do URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/cloudflared.log" | head -1 || true); [ -n "${URL:-}" ] && break; sleep 1; done
echo "JENA_LLM_BASE_URL=$URL/v1"

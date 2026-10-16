---
title: JenaXI ZeroGPU
emoji: 🧠
colorFrom: purple
colorTo: indigo
sdk: gradio
app_file: app.py
python_version: "3.12"
pinned: false
---

# JenaXI ZeroGPU inference worker

This is an optional Hugging Face Spaces ZeroGPU worker for request/response model inference. It is not a permanent GPU server and cannot host SteamVR, a real Linux desktop, or XR rendering.

## Configure this Space

1. In this Space's **Settings → Hardware**, select **ZeroGPU**.
2. Add Space variables/secrets:
   - **JENAXI_ZEROGPU_MODEL_ID**: a Transformers-compatible model repository. It defaults to **Qwen/Qwen2.5-1.5B-Instruct** as a working baseline; set it to JenaXI's merged Hugging Face model only after that model is published in a Transformers/Safetensors format.
   - **JENAXI_MAX_INPUT_TOKENS**: input prompt limit, default 16384, maximum 32768 in this template.
   - **JENAXI_MAX_NEW_TOKENS**: output cap, default 256, maximum 1024.
   - **HF_TOKEN**: secret only if the chosen model is gated/private.
   - Optional **JENAXI_SYSTEM_PROMPT**.
3. Commit this folder's contents to the existing JenaXI Space repository (or create a dedicated Gradio Space from this directory). This GitHub branch does not change the Hugging Face Space by itself.

The model is loaded at module startup and placed on CUDA as recommended by ZeroGPU docs; only the function decorated with the GPU allocation decorator performs inference under the allocated GPU window. Do not set torch.compile; ZeroGPU does not support it. Use prebuilt wheels for CUDA extensions.

## Connect Jena's existing box

After this code is deployed to a public Space, set the existing box environment variable:

    JENA_ZEROGPU_SPACE_URL=https://saidie000-jenaxi.hf.space

The Jena gateway includes an opt-in remote-backend adapter on this branch. It calls the Space's Gradio API named chat_completions when this variable is set and falls back to the local llama.cpp model if the Space errors or times out. Leave the variable unset to keep the existing local-only inference path.

Do not put HF access tokens in frontend code. If authentication is needed, keep the token as a secret on the Jena box, not in browser JavaScript.

## Limits and expectations

ZeroGPU schedules shared NVIDIA GPU access when a decorated function is called, then releases it after that function finishes. Queue time and GPU quota apply; it is not guaranteed to be continuously available. A small model may see faster token generation on GPU, but long prompt prefill, queue delay, cold startup, and context size can offset that benefit. The Jena box's CPU inference remains the fallback.

The default Qwen model is a baseline, not JenaXI's trained weights. This template does not retrain the model. A published compatible model checkpoint is required to serve the trained JenaXI weights from ZeroGPU.

## Upstream references

- Spaces ZeroGPU: https://huggingface.co/docs/hub/main/spaces-zerogpu
- Qwen2.5-1.5B-Instruct: https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct

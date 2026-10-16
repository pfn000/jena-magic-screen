"""On-demand JenaXI inference on Hugging Face Spaces ZeroGPU.

This is a separate inference worker. It does not run SteamVR, Linux desktops, or a permanent GPU daemon.
"""
from __future__ import annotations

import os
import time
import uuid
from typing import Any

import gradio as gr
import spaces
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL_ID = os.environ.get("JENAXI_ZEROGPU_MODEL_ID", "Qwen/Qwen2.5-1.5B-Instruct")
HF_TOKEN = os.environ.get("HF_TOKEN") or None
MAX_INPUT_TOKENS = max(1024, min(int(os.environ.get("JENAXI_MAX_INPUT_TOKENS", "8192")), 32768))
MAX_NEW_TOKENS = max(16, min(int(os.environ.get("JENAXI_MAX_NEW_TOKENS", "256")), 1024))
SYSTEM_PROMPT = os.environ.get(
    "JENAXI_SYSTEM_PROMPT",
    "You are JenaXI, an AI created by Saidie / NCOM Systems. Be helpful, clever, accurate, "
    "and clear about uncertainty. Use tools only when they are explicitly available.",
)

# ZeroGPU documents that model placement belongs at module scope. CUDA emulation is
# available during Space startup; actual GPU execution occurs inside @spaces.GPU.
TOKENIZER = AutoTokenizer.from_pretrained(MODEL_ID, token=HF_TOKEN)
MODEL = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.bfloat16,
    token=HF_TOKEN,
).to("cuda").eval()


def _messages(payload: dict[str, Any]) -> list[dict[str, str]]:
    raw = payload.get("messages")
    if not isinstance(raw, list) or not raw:
        raise ValueError("messages must be a non-empty array")
    cleaned: list[dict[str, str]] = []
    for item in raw[-80:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in {"system", "user", "assistant"} or not isinstance(content, str):
            continue
        cleaned.append({"role": role, "content": content[:12000]})
    if not cleaned:
        raise ValueError("messages contains no supported text turns")

    systems = [i for i, item in enumerate(cleaned) if item["role"] == "system"]
    if systems:
        cleaned[systems[0]]["content"] = SYSTEM_PROMPT + "\n\n" + cleaned[systems[0]]["content"]
        for i in reversed(systems[1:]):
            cleaned.pop(i)
    else:
        cleaned.insert(0, {"role": "system", "content": SYSTEM_PROMPT})
    if not any(item["role"] == "user" for item in cleaned):
        raise ValueError("messages must include a user turn")
    return cleaned


def _encode(messages: list[dict[str, str]]):
    return TOKENIZER.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_tensors="pt",
        return_dict=True,
    )


def _fit_context(messages: list[dict[str, str]], reserve_tokens: int):
    """Drop oldest conversation turns before trimming the current request."""
    budget = max(512, MAX_INPUT_TOKENS - reserve_tokens)
    encoded = _encode(messages)
    while encoded["input_ids"].shape[-1] > budget:
        non_system = [i for i, msg in enumerate(messages) if msg["role"] != "system"]
        if len(non_system) <= 1:
            break
        # Drop the oldest non-system turn but retain the newest user request.
        index = non_system[0]
        messages.pop(index)
        encoded = _encode(messages)

    if encoded["input_ids"].shape[-1] > budget:
        # A single huge request cannot preserve the whole prompt. Keep its tail so the
        # latest instruction is retained, while the system message stays intact.
        user_indexes = [i for i, msg in enumerate(messages) if msg["role"] == "user"]
        if user_indexes:
            idx = user_indexes[-1]
            content = messages[idx]["content"]
            messages[idx]["content"] = content[-4000:]
            encoded = _encode(messages)

    if encoded["input_ids"].shape[-1] > MAX_INPUT_TOKENS:
        raise ValueError(
            f"Prompt is larger than the configured {MAX_INPUT_TOKENS}-token input limit; "
            "shorten the system prompt or the latest message."
        )
    return encoded


@spaces.GPU(duration=60)
def complete(payload: dict[str, Any]) -> dict[str, Any]:
    """OpenAI-shaped completion response for the Jena gateway Gradio API client."""
    if not isinstance(payload, dict):
        raise ValueError("request must be a JSON object")
    messages = _messages(payload)
    temperature = float(payload.get("temperature", 0.6))
    temperature = min(max(temperature, 0.0), 1.5)
    top_p = float(payload.get("top_p", 0.9))
    top_p = min(max(top_p, 0.05), 1.0)
    requested_new = int(payload.get("max_new_tokens", payload.get("max_tokens", MAX_NEW_TOKENS)))
    max_new = min(max(requested_new, 1), MAX_NEW_TOKENS)
    encoded = _fit_context(messages, max_new)
    input_ids = encoded["input_ids"].to("cuda")
    input_length = int(input_ids.shape[-1])

    kwargs: dict[str, Any] = {
        "max_new_tokens": max_new,
        "do_sample": temperature > 0,
        "pad_token_id": TOKENIZER.pad_token_id if TOKENIZER.pad_token_id is not None else TOKENIZER.eos_token_id,
        "eos_token_id": TOKENIZER.eos_token_id,
    }
    if temperature > 0:
        kwargs["temperature"] = temperature
        kwargs["top_p"] = top_p

    with torch.inference_mode():
        output = MODEL.generate(input_ids=input_ids, **kwargs)
    completion_ids = output[0, input_length:]
    text = TOKENIZER.decode(completion_ids, skip_special_tokens=True).strip()
    completion_tokens = int(completion_ids.shape[-1])
    prompt_tokens = input_length
    return {
        "id": "chatcmpl-" + uuid.uuid4().hex,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "length" if completion_tokens >= max_new else "stop",
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


def _chat_ui(message: str, history: list[dict[str, str]]) -> str:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for item in (history or [])[-40:]:
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"} and isinstance(item.get("content"), str):
            messages.append({"role": item["role"], "content": item["content"]})
    messages.append({"role": "user", "content": message})
    result = complete({"messages": messages, "max_new_tokens": MAX_NEW_TOKENS, "temperature": 0.6})
    return result["choices"][0]["message"]["content"]


with gr.Blocks(title="JenaXI · ZeroGPU") as demo:
    gr.Markdown(
        "# JenaXI · ZeroGPU\n"
        "On-demand GPU-backed inference. This is a model worker, not a full Linux desktop or VR host."
    )
    with gr.Tab("Chat"):
        gr.ChatInterface(fn=_chat_ui, type="messages", title="Chat with JenaXI")
    with gr.Tab("Gateway API"):
        gr.Markdown(
            "The chat_completions API accepts one JSON object with messages, temperature, "
            "top_p, and max_new_tokens. It returns an OpenAI-compatible chat-completion object."
        )
        gr.Interface(
            fn=complete,
            inputs=gr.JSON(label="Request JSON"),
            outputs=gr.JSON(label="Chat completion"),
            api_name="chat_completions",
            title="JenaXI API",
        )

if __name__ == "__main__":
    demo.queue(max_size=16).launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("PORT", "7860")),
    )

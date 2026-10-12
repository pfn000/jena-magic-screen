# JenaXI on free Google Colab

Two notebooks that train Jena's brain on Google Colab's **free** T4 GPU, using Saidie's own Google account. They cost $0.

| Notebook | What it makes | Time | Open |
|---|---|---|---|
| `JenaXI-1_from_scratch.ipynb` | **JenaXI-1**, about 110M params, Llama architecture, **random init**: no pretrained weights from any model. Own 32k SentencePiece BPE tokenizer. | about 5 sessions of ~3.5 h (resumable) | [Open in Colab](https://colab.research.google.com/github/pfn000/jena-magic-screen/blob/main/colab/JenaXI-1_from_scratch.ipynb) |
| `JenaXI-chat_GPU_finetune.ipynb` | **JenaXI-chat-gpu**: LoRA fine-tune of **Qwen2.5-1.5B-Instruct** (Apache-2.0), merged, GGUF Q4_K_M | 1 session, ~1.5 h | [Open in Colab](https://colab.research.google.com/github/pfn000/jena-magic-screen/blob/main/colab/JenaXI-chat_GPU_finetune.ipynb) |

**How to use:** Runtime → Change runtime type → **T4 GPU** → Runtime → **Run all** → approve the Google Drive popup. Everything is saved to **My Drive → JenaXI**. If Colab disconnects, Run all again and it continues.

## Outputs (Google Drive → My Drive → JenaXI)
- `JenaXI-1.gguf`: from-scratch Jena (Q8_0). It is refreshed at the end of every session, so it's a preview until pretraining hits its target.
- `JenaXI-1/`: tokenizer, checkpoints (`ckpt/latest.pt`, `ckpt/prev.pt`), data progress, logs, and the Hugging Face model folder `JenaXI-1-hf/`.
- `JenaXI-chat-gpu.gguf`: the fine-tuned chat Jena (Q4_K_M, ~1 GB).
- `JenaXI-chat/`: LoRA checkpoints and `adapter_final/`.

## JenaXI-1 details
- Model: 12 layers, hidden 768, 12 heads, SwiGLU 2048, RoPE, tied embeddings, context 1024.
- Pretraining data (streamed from Hugging Face): FineWeb-Edu sample-10BT (ODC-By) 68%, English Wikipedia 20231101 (CC BY-SA) 17%, Project Gutenberg English (public domain) 5%, TinyStories (CDLA-Sharing; synthetic stories) 5%, chat text 5% (OpenAssistant oasst1, Apache-2.0; Dolly-15k, CC BY-SA 3.0; Jena persona).
- Default target is 1B tokens (65,536 tokens per step). fp16 mixed precision on T4. Checkpoints every 15 min. A background helper builds 50M-token shards ahead of the trainer and deletes used shards.
- Persona SFT runs at the end of every session, starting from the current pretraining checkpoint. Same chat tags as JenaXI-0 and the site: `<|mama|>…\n<|jena|>…</s>`.
- Export uses llama.cpp `convert_hf_to_gguf.py` (tag b11574), Q8_0.

## JenaXI-chat details
- Base: `Qwen/Qwen2.5-1.5B-Instruct`, license **Apache-2.0** (© Alibaba Cloud). The 3B model was skipped because its license is not Apache.
- LoRA r=32 on all attention and MLP projections, 2 epochs, fp16. Data: Jena persona chats (×4, plus 500 in the site's THINK/MOOD/ACTION/SAY format) and 3,000 oasst1 + 1,500 Dolly human-written chats.
- The chat template's default system prompt is replaced with Jena's, so she is Jena even with no system message.
- Merge → GGUF f16 → `llama-quantize Q4_K_M` (official prebuilt llama.cpp b11574; falls back to building it).

## Persona data
`data/jena_persona.jsonl` has 636 conversations (654 exchanges), all written by hand for this project: the 352 JenaXI-0 lines plus 284 new ones (mama, stream viewers, strangers). No generated or paid-API data. Jena is a teen: nothing flirty or sexual, and the data includes deflections for that.

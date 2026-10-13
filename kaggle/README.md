# Jena on Kaggle's free GPU

Real training for JenaXI on Kaggle's free T4 GPUs, started and resumed automatically, no PC needed.

| job | what it trains | Kaggle notebook (private) |
|---|---|---|
| `chat` | JenaXI-chat: LoRA fine-tune of Qwen2.5-1.5B-Instruct (Apache-2.0) on her persona chats + OpenAssistant + Dolly, then merge + GGUF Q4_K_M | https://www.kaggle.com/code/saidienewara/jenaxi-chat-gpu |
| `jx1` | JenaXI-1: ~110M-param model from random weights with her own tokenizer (FineWeb-Edu, Wikipedia, Gutenberg, TinyStories), persona SFT, GGUF | https://www.kaggle.com/code/saidienewara/jenaxi-1-scratch-gpu |

## How it works
- `kernel_chat.py` / `kernel_jx1.py` are what Kaggle runs: they clone this repo and run `runner.py <job>`.
- `runner.py` prints the GPU it got (`nvidia-smi`, `torch.cuda`), resumes from the previous version's output
  (`/kaggle/input/<notebook>/JenaXI-*`), trains with the same code as the Colab notebooks (`colab/`), and writes
  checkpoints, `status.json` and the final `.gguf` to `/kaggle/working` (Kaggle keeps it as the version's output).
- Extra chats Jena learned (her Grok notes) are synced by Tab into the private dataset
  `saidienewara/jenaxi-training-data` and merged (deduped) into the persona chats for that session.
- Tab's box checks every few hours: finished-but-not-done → next version resumes; error → retry (max 3 in a row);
  done → the GGUF is pulled to Jena's box for a test (the live brain is only swapped after a check).

## Limits (Saidie's account, read from Kaggle's quota API on 2026-10-13)
- GPU: 30 h per week (108,000 s), resets Saturday 00:00 UTC. TPU: 20 h per week.
- One session runs at most 12 h; Kaggle allows 2 GPU sessions at once per account. Two at once = twice the speed,
  but the same 30 h is spent twice as fast.

## Backup driver (optional)
`.github/workflows/kaggle-train.yml` does the same with the official Kaggle CLI. It stays off unless the repo variable
`JENA_KAGGLE_DRIVER` = `github` and the secrets `KAGGLE_USERNAME` / `KAGGLE_KEY` are set
(kaggle.com → Settings → API → Create New Token). Paste the key into GitHub yourself; never send it in a chat.

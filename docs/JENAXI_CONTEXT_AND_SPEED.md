# JenaXI: longer context and faster inference

This change updates the runtime and chat fine-tune configuration; it does not change the model's learned weights until the chat fine-tune is run and its GGUF is redeployed.

## What changed

- JenaXI-chat requests up to 32,768 context tokens per slot, with two slots for two simultaneous requests. Current llama.cpp builds use the explicit per-slot KV-pool option; older builds fall back to a 65,536-token total context pool.
- K/V cache defaults to q8_0, with Flash Attention enabled when the server binary exposes those flags. This reduces KV-cache memory compared with full-precision cache and can make longer contexts practical. Backend/model compatibility and actual speed still need to be benchmarked.
- ngram-mod speculative decoding is enabled by default. It is lightweight and needs no separate draft-model file; it can accelerate repeated token patterns, but it is workload-dependent and is not a promise of faster generation for every prompt.
- The fallback JenaXI-0 remains at its existing 1,024-token context because it is a separately trained small model. Increasing its context will not make that model smarter.
- The gateway now stores a bounded recent-turn history (up to 40 messages / 36,000 characters) for actual website traffic and reloads it into the next prompt. Private mama history and public chat history are stored separately. This makes the larger window usable instead of repeatedly sending a single isolated question.
- The chat fine-tuning cap grows from 768 to 2,048 tokens so longer training examples are not cut off as early.

## Configuration

These values are read by the Docker supervisor when the box starts:

| Variable | Default | Meaning |
|---|---:|---|
| JENA_CHAT_CTX_PER_SLOT | 32768 | Per-request context limit with current llama.cpp; keep within the model's supported 32K window |
| JENA_CHAT_CTX_TOTAL | 65536 | Fallback total context pool for builds without the per-slot option; per-slot setting takes precedence on current builds |
| JENA_CHAT_PARALLEL | 2 | Simultaneous requests; the total pool is divided among slots |
| JENA_CHAT_THREADS | 3 | Generation CPU threads |
| JENA_CHAT_THREADS_BATCH | 3 | Prompt-processing CPU threads |
| JENA_CHAT_BATCH / JENA_CHAT_UBATCH | 512 / 128 | Logical/physical batch sizes |
| JENA_KV_CACHE_K / JENA_KV_CACHE_V | q8_0 / q8_0 | Quantized K/V cache types |
| JENA_FLASH_ATTN | on | Flash Attention: on, off, or auto |
| JENA_SPEC_TYPE | ngram-mod | Set to none to disable speculative decoding |
| JENA_SPEC_NGRAM_MATCH | 24 | n-gram lookup length |
| JENA_SPEC_NGRAM_MIN / JENA_SPEC_NGRAM_MAX | 48 / 64 | Speculative draft range |
| JENA_TRAIN_MAX_LEN | 2048 | Chat fine-tune sequence cap; 4,096 is an opt-in experiment |

## Larger windows

The fine-tuned chat model is based on Qwen/Qwen2.5-1.5B-Instruct, whose documented context capacity is 32K tokens. The current server targets up to 32K tokens per request and allows two simultaneous requests. Do not set the runtime above the architecture's supported limit without a deliberate RoPE-scaling experiment and validation. Longer context consumes more memory and usually increases prompt-prefill latency; it is useful when the conversation actually needs that history, not as a universal speed boost. The gateway's bounded history is a separate limit from the model's 32K context and should be tested with the actual tokenizer.

The standalone box/start-jenaxi.sh uses a single slot and defaults to CTX=16384; set CTX=32768 there to target the model's full 32K window if resources permit. For the supervised chat process, change JENA_CHAT_CTX_PER_SLOT (not CTX) to tune the per-request budget.

## Re-training the chat model

The max_len=2048 setting applies only to training runs using the updated script. Re-run the chat job and let it finish, export a new GGUF, smoke-test it, then deploy the new artifact. For an already completed adapter, the runner's completion check will skip fine-tuning; start a clean training output or remove the previous final adapter/checkpoint from the training workspace before requesting a new run. On a GPU with sufficient VRAM, JENA_TRAIN_MAX_LEN=4096 asks the Kaggle runner to use 4K sequences; monitor for out-of-memory errors and slower training. The default remains 2K to keep the free-T4 path realistic.

## Verify after deployment

1. Confirm /health reports the model is healthy.
2. Check llama-server logs for the loaded context and slot count; confirm each slot has the expected context capacity before advertising a larger window.
3. Send a long prompt with a unique fact near its beginning and ask the model about that fact after the prompt; test several lengths (4K, 8K, 16K and, if enabled, 32K tokens).
4. Benchmark the same short and long prompts before and after this change. Compare time-to-first-token, output tokens/second, and memory use. Do not claim a speedup until measurements exist. ngram-mod can help repetitive workloads, while Flash Attention/cache quantization affect memory and attention cost.

## Upstream references

- llama.cpp server options: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- llama.cpp speculative decoding: https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md
- Qwen2.5-1.5B-Instruct: https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct

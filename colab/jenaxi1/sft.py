# Step 4: persona SFT. Teaches JenaXI-1 to chat as Jena (+ general human-written chat so she stays useful).
# Starts from the CURRENT pretraining checkpoint (her own weights) and saves a Hugging Face model folder.
import os, sys, json, time, random, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch
from common import (load_config, run_dir, load_persona, oasst_pairs, dolly_pairs, general_chat_files, wrap_user,
                    SYSTEMS, MAMA, JENA, SYSTEM, SMOKE, CHAT_TEMPLATE)
import sentencepiece as spm
from transformers import LlamaForCausalLM
from pretrain import model_config, load_ckpt

R = run_dir()

def render(sp, conv, who, rng, L):
    ids, labels = [sp.bos_id()], [-100]
    if rng.random() < 0.5:
        s = sp.encode(SYSTEM + rng.choice(SYSTEMS[who]) + "\n"); ids += s; labels += [-100] * len(s)
    for u, a in conv:
        p = sp.encode(MAMA + (u if who == "general" else wrap_user(u, who, rng)) + "\n" + JENA)
        r = sp.encode(a) + [sp.eos_id()]
        nl = sp.encode("\n")
        ids += p + r + nl; labels += [-100] * len(p) + r + [-100] * len(nl)
    return ids[:L], labels[:L]

def build(sp, cfg):
    rng = random.Random(42)
    persona = [(c["who"], [(t["user"], t["jena"]) for t in c["turns"]]) for c in load_persona()]
    o, d = general_chat_files()
    general = [("general", c) for c in oasst_pairs(o)] + [("general", c) for c in dolly_pairs(d, 6000)]
    items = persona * (12 if not SMOKE else 2) + general
    # stitch some persona exchanges into longer chats (like real conversations on the site)
    for _ in range(1500 if not SMOKE else 10):
        k = rng.randint(2, 4); pick = [rng.choice(persona) for _ in range(k)]
        if len({w for w, _ in pick}) == 1: items.append((pick[0][0], [t for _, c in pick for t in c]))
    rng.shuffle(items)
    return [render(sp, c, w, rng, cfg["seq_len"]) for w, c in items]

def main():
    cfg = load_config()
    sp = spm.SentencePieceProcessor(model_file=os.path.join(R, "tokenizer", "jenaxi1.model"))
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    bf16 = dev.type == "cuda" and torch.cuda.is_bf16_supported() and "T4" not in torch.cuda.get_device_name(0)
    amp = torch.bfloat16 if bf16 else torch.float16
    ck, name = load_ckpt()
    if not ck: raise SystemExit("No pretraining checkpoint yet - run the pretraining cell first.")
    model = LlamaForCausalLM(model_config(cfg, sp.vocab_size())); model.load_state_dict(ck["model"]); model.to(dev).train()
    pre_step = ck["step"]; del ck
    data = build(sp, cfg)
    print(f"Persona SFT: {len(data):,} chats | starting from pretraining step {pre_step:,}")
    opt = torch.optim.AdamW(model.parameters(), lr=cfg["sft_lr"], betas=(0.9, 0.95), weight_decay=0.0, fused=dev.type == "cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=(dev.type == "cuda" and amp == torch.float16))
    B, A, steps = cfg["sft_micro_batch"], cfg["sft_grad_accum"], cfg["sft_steps"]
    rng = random.Random(0); order = list(range(len(data))); rng.shuffle(order); pos = 0; t0 = time.time()
    for step in range(steps):
        lr = cfg["sft_lr"] * min(1.0, (step + 1) / 50) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * step / steps)))
        for g in opt.param_groups: g["lr"] = lr
        tot = 0.0
        for _ in range(A):
            batch = []
            for _ in range(B):
                if pos >= len(order): rng.shuffle(order); pos = 0
                batch.append(data[order[pos]]); pos += 1
            m = max(len(x[0]) for x in batch)
            ids = torch.tensor([x[0] + [sp.eos_id()] * (m - len(x[0])) for x in batch], device=dev)
            lab = torch.tensor([x[1] + [-100] * (m - len(x[1])) for x in batch], device=dev)
            att = torch.tensor([[1] * len(x[0]) + [0] * (m - len(x[0])) for x in batch], device=dev)
            with torch.autocast(device_type=dev.type, dtype=amp, enabled=dev.type == "cuda"):
                loss = model(input_ids=ids, attention_mask=att, labels=lab).loss / A
            scaler.scale(loss).backward(); tot += loss.item()
        scaler.unscale_(opt); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True)
        if (step + 1) % (1 if SMOKE else 50) == 0 or step == steps - 1:
            print(f"  sft step {step+1}/{steps} | loss {tot:.3f} | {time.time()-t0:.0f}s", flush=True)
    out = os.path.join(R, "JenaXI-1-hf")
    os.makedirs(out, exist_ok=True)
    model.config.architectures = ["LlamaForCausalLM"]
    model.to(torch.float32).save_pretrained(out, safe_serialization=True)
    import shutil
    shutil.copy(os.path.join(R, "tokenizer", "jenaxi1.model"), os.path.join(out, "tokenizer.model"))
    json.dump({"tokenizer_class": "LlamaTokenizer", "add_bos_token": True, "add_eos_token": False, "bos_token": "<s>", "eos_token": "</s>",
               "unk_token": "<unk>", "model_max_length": cfg["seq_len"], "legacy": False, "chat_template": CHAT_TEMPLATE, "add_prefix_space": True,
               "added_tokens_decoder": {str(i): {"content": t, "special": True, "lstrip": False, "rstrip": False, "normalized": False, "single_word": False}
                                         for i, t in [(0, "<unk>"), (1, "<s>"), (2, "</s>"), (3, MAMA), (4, JENA), (5, SYSTEM)]}},
              open(os.path.join(out, "tokenizer_config.json"), "w"), indent=1)
    json.dump({"bos_token": "<s>", "eos_token": "</s>", "unk_token": "<unk>"}, open(os.path.join(out, "special_tokens_map.json"), "w"))
    json.dump({"name": "JenaXI-1", "from_scratch": True, "pretrain_step": pre_step, "pretrain_done": os.path.exists(os.path.join(R, "PRETRAIN_DONE")),
               "built": time.ctime()}, open(os.path.join(out, "jenaxi_info.json"), "w"), indent=1)
    print("Saved Hugging Face model to", out)

if __name__ == "__main__":
    main()

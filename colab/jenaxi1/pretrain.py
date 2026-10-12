# Step 3: pretrain JenaXI-1 from RANDOM weights. Resumable: run it again and it continues where it stopped.
import os, sys, json, time, math, signal, subprocess, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, torch
from common import load_config, save_config, run_dir, human, SMOKE
import sentencepiece as spm
from transformers import LlamaConfig, LlamaForCausalLM

STOP = {"flag": False}
def _stop(sig, frm):
    print("\n[stop requested] saving a checkpoint before exiting...", flush=True); STOP["flag"] = True
signal.signal(signal.SIGINT, _stop); signal.signal(signal.SIGTERM, _stop)

R = run_dir()
CK = os.path.join(R, "ckpt"); os.makedirs(CK, exist_ok=True)
LOGS = os.path.join(R, "logs"); os.makedirs(LOGS, exist_ok=True)

def model_config(cfg, vocab):
    return LlamaConfig(vocab_size=vocab, hidden_size=cfg["hidden_size"], intermediate_size=cfg["intermediate_size"],
        num_hidden_layers=cfg["num_layers"], num_attention_heads=cfg["num_heads"], num_key_value_heads=cfg["num_kv_heads"],
        max_position_embeddings=cfg["seq_len"], rms_norm_eps=1e-5, rope_theta=10000.0, tie_word_embeddings=True,
        bos_token_id=1, eos_token_id=2, pad_token_id=None, hidden_act="silu", attention_bias=False, mlp_bias=False)

def save_ckpt(state):
    tmp = os.path.join(CK, "latest.tmp.pt")
    torch.save(state, tmp)
    lp, pp = os.path.join(CK, "latest.pt"), os.path.join(CK, "prev.pt")
    if os.path.exists(lp): os.replace(lp, pp)
    os.replace(tmp, lp)

def load_ckpt():
    for name in ["latest.pt", "prev.pt"]:
        p = os.path.join(CK, name)
        if os.path.exists(p):
            try:
                return torch.load(p, map_location="cpu", weights_only=False), name
            except Exception as e:
                print(f"  could not read {name} ({e}); trying the backup", flush=True)
    return None, None

def shard_path(k): return os.path.join(R, "shards", f"shard_{k:05d}.bin")

def write_progress(**kw):
    p = os.path.join(R, "progress.json"); tmp = p + ".tmp"
    json.dump(kw, open(tmp, "w")); os.replace(tmp, p)

def lr_at(step, total, cfg):
    if step < cfg["warmup_steps"]: return cfg["lr"] * (step + 1) / cfg["warmup_steps"]
    p = min(1.0, (step - cfg["warmup_steps"]) / max(1, total - cfg["warmup_steps"]))
    return cfg["min_lr"] + 0.5 * (cfg["lr"] - cfg["min_lr"]) * (1 + math.cos(math.pi * p))

class Batches:
    def __init__(self, cfg, shard, win):
        self.cfg, self.k, self.w = cfg, shard, win; self._load()
    def _load(self):
        waited = 0
        while not os.path.exists(shard_path(self.k)):
            if waited % 60 == 0: print(f"  waiting for data shard {self.k} (being built in the background)...", flush=True)
            time.sleep(5); waited += 5
            if STOP["flag"]: raise KeyboardInterrupt
        self.arr = np.memmap(shard_path(self.k), dtype=np.uint16, mode="r")
        n = len(self.arr) // self.cfg["seq_len"]
        self.perm = np.random.default_rng(1234 + self.k).permutation(n)
    def next(self, b):
        L, out = self.cfg["seq_len"], []
        while len(out) < b:
            if self.w >= len(self.perm):
                old = self.k; self.k += 1; self.w = 0; self._load()
                try: os.remove(shard_path(old))          # used up, free the Drive space
                except OSError: pass
                continue
            i = int(self.perm[self.w]); self.w += 1
            out.append(torch.from_numpy(self.arr[i * L:(i + 1) * L].astype(np.int64)))
        return torch.stack(out)

@torch.no_grad()
def evaluate(model, cfg, dev, amp_dtype, n_batches=20):
    p = os.path.join(R, "shards", "val.bin")
    if not os.path.exists(p): return float("nan")
    arr = np.memmap(p, dtype=np.uint16, mode="r"); L = cfg["seq_len"]; n = len(arr) // L
    model.eval(); losses = []
    for j in range(min(n_batches, max(1, n // cfg["micro_batch"]))):
        idx = [(j * cfg["micro_batch"] + t) % n for t in range(cfg["micro_batch"])]
        x = torch.stack([torch.from_numpy(arr[i * L:(i + 1) * L].astype(np.int64)) for i in idx]).to(dev)
        with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=dev.type == "cuda"):
            losses.append(model(input_ids=x, labels=x).loss.float().item())
    model.train(); return sum(losses) / len(losses)

@torch.no_grad()
def peek(model, sp, dev, amp_dtype, prompt="Once upon a time", n=40):
    model.eval()
    x = torch.tensor([[sp.bos_id()] + sp.encode(prompt)], device=dev)
    with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=dev.type == "cuda"):
        y = model.generate(x, max_new_tokens=n, do_sample=True, temperature=0.8, top_k=40, pad_token_id=sp.eos_id())
    model.train(); return sp.decode(y[0].tolist()[1:])

def main():
    cfg = load_config(); save_config(cfg)
    if os.path.exists(os.path.join(R, "PRETRAIN_DONE")):
        print("Pretraining already finished. Skipping to persona training + export."); return
    sp = spm.SentencePieceProcessor(model_file=os.path.join(R, "tokenizer", "jenaxi1.model"))
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if dev.type == "cuda":
        print("GPU:", torch.cuda.get_device_name(0)); torch.backends.cuda.matmul.allow_tf32 = True
    else:
        print("WARNING: no GPU found. Runtime -> Change runtime type -> T4 GPU, then Run all again." if not SMOKE else "(smoke test on CPU)")
        if not SMOKE: sys.exit(1)
    bf16 = dev.type == "cuda" and torch.cuda.is_bf16_supported() and "T4" not in torch.cuda.get_device_name(0)
    amp_dtype = torch.bfloat16 if bf16 else torch.float16
    torch.manual_seed(1337)
    model = LlamaForCausalLM(model_config(cfg, sp.vocab_size()))   # RANDOM INIT: no pretrained weights
    try: model.config._attn_implementation = "sdpa"
    except Exception: pass
    model.to(dev)
    nparams = sum(p.numel() for p in model.parameters())
    decay = [p for n, p in model.named_parameters() if p.dim() >= 2]
    nodecay = [p for n, p in model.named_parameters() if p.dim() < 2]
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": cfg["weight_decay"]}, {"params": nodecay, "weight_decay": 0.0}],
                            lr=cfg["lr"], betas=(0.9, 0.95), eps=1e-8, fused=dev.type == "cuda")
    scaler = torch.amp.GradScaler("cuda", enabled=(dev.type == "cuda" and amp_dtype == torch.float16))
    tps = cfg["micro_batch"] * cfg["grad_accum"] * cfg["seq_len"]
    total_steps = max(1, cfg["target_tokens"] // tps)
    step, shard, win, prior_secs = 0, 0, 0, 0.0
    ck, name = load_ckpt()
    if ck:
        model.load_state_dict(ck["model"]); opt.load_state_dict(ck["opt"])
        if ck.get("scaler"): scaler.load_state_dict(ck["scaler"])
        step, shard, win, prior_secs = ck["step"], ck["shard"], ck["win"], ck.get("train_secs", 0.0)
        print(f"Resumed from {name}: step {step:,}/{total_steps:,} ({100*step/total_steps:.1f}% done)")
    else:
        print("Starting fresh from random weights.")
    print(f"JenaXI-1: {nparams/1e6:.1f}M parameters | {tps:,} tokens/step | target {human(cfg['target_tokens'])} tokens = {total_steps:,} steps")
    # background helper that keeps the next data shards ready
    helper = subprocess.Popen(["nice", "-n", "10", sys.executable, "-u", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data_build.py"), "--loop"])
    write_progress(shard=shard, step=step, done=False)
    data = Batches(cfg, shard, win)
    log = open(os.path.join(LOGS, "pretrain_log.csv"), "a")
    t_start = time.time(); t_ck = t_ev = time.time(); t_log = time.time(); tok_since = 0
    budget = cfg["session_hours"] * 3600
    model.train()
    try:
        while step < total_steps and not STOP["flag"]:
            lr = lr_at(step, total_steps, cfg)
            for g in opt.param_groups: g["lr"] = lr
            loss_acc = 0.0
            for _ in range(cfg["grad_accum"]):
                x = data.next(cfg["micro_batch"]).to(dev, non_blocking=True)
                with torch.autocast(device_type=dev.type, dtype=amp_dtype, enabled=dev.type == "cuda"):
                    loss = model(input_ids=x, labels=x).loss / cfg["grad_accum"]
                scaler.scale(loss).backward(); loss_acc += loss.item()
            scaler.unscale_(opt); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True)
            step += 1; tok_since += tps
            if step % (1 if SMOKE else 20) == 0:
                dt = time.time() - t_log; tok_s = tok_since / max(dt, 1e-6); t_log = time.time(); tok_since = 0
                left_h = (total_steps - step) * tps / max(tok_s, 1) / 3600
                print(f"step {step:,}/{total_steps:,} ({100*step/total_steps:.1f}%) | loss {loss_acc:.3f} | lr {lr:.2e} | "
                      f"{tok_s/1000:.1f}k tok/s | ~{left_h:.1f} GPU-hours left (~{max(1, math.ceil(left_h/cfg['session_hours']))} more sessions)", flush=True)
                log.write(f"{step},{step*tps},{loss_acc:.4f},{lr:.6f},{tok_s:.0f}\n"); log.flush()
                write_progress(shard=data.k, step=step, done=False)
            if time.time() - t_ev > cfg["eval_minutes"] * 60:
                vl = evaluate(model, cfg, dev, amp_dtype)
                print(f"  [eval] validation loss {vl:.3f} | sample: {peek(model, sp, dev, amp_dtype)!r}", flush=True)
                log.write(f"eval,{step},{vl:.4f}\n"); log.flush(); t_ev = time.time()
            if time.time() - t_ck > cfg["ckpt_minutes"] * 60:
                save_ckpt(dict(model=model.state_dict(), opt=opt.state_dict(), scaler=scaler.state_dict(), step=step, shard=data.k,
                               win=data.w, train_secs=prior_secs + time.time() - t_start, cfg=cfg))
                print(f"  [saved checkpoint to Drive at step {step:,}]", flush=True); t_ck = time.time()
            if time.time() - t_start > budget:
                print(f"Session time budget ({cfg['session_hours']} h) reached.", flush=True); break
    except KeyboardInterrupt:
        pass
    save_ckpt(dict(model=model.state_dict(), opt=opt.state_dict(), scaler=scaler.state_dict(), step=step, shard=data.k,
                   win=data.w, train_secs=prior_secs + time.time() - t_start, cfg=cfg))
    done = step >= total_steps
    write_progress(shard=data.k, step=step, done=done)
    vl = evaluate(model, cfg, dev, amp_dtype)
    print(f"Saved. step {step:,}/{total_steps:,} ({100*step/total_steps:.1f}%), validation loss {vl:.3f}")
    if done:
        open(os.path.join(R, "PRETRAIN_DONE"), "w").write(time.ctime())
        open(os.path.join(R, "STOP_DATA"), "w").write("done")
        print("PRETRAINING COMPLETE.")
    else:
        print("Not finished yet - that's normal. Next time: open the notebook and Run all again; it continues from here.")
    helper.terminate()

if __name__ == "__main__":
    main()

# Jena on Kaggle: one long session does the whole job, saves checkpoints to /kaggle/working
# (Kaggle keeps that folder as the version's output), and the NEXT version resumes from it.
# Jobs: "chat"  = JenaXI-chat LoRA fine-tune of Qwen2.5-1.5B-Instruct (Apache-2.0) -> JenaXI-chat-gpu.gguf
#       "jx1"   = JenaXI-1, ~110M params from random weights, her own tokenizer -> JenaXI-1.gguf
# Nothing here is simulated: every line in the log is printed by the real step that ran.
import os, sys, json, time, glob, shutil, subprocess, datetime

JOB = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("JENA_JOB", "chat")).strip()
W = "/kaggle/working" if os.path.isdir("/kaggle") else os.path.abspath("kaggle_working")
TMP = "/tmp/jena"
REPO = "/tmp/jena-magic-screen"
T0 = time.time()
SESSION_LIMIT_H = float(os.environ.get("JENA_SESSION_LIMIT_H", "11.5"))   # Kaggle stops a session at 12 h
os.makedirs(W, exist_ok=True); os.makedirs(TMP, exist_ok=True)

def now(): return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def say(*a): print(f"[jena-kaggle {now()}]", *a, flush=True)

STATUS = os.path.join(W, "status.json")
def status(**kv):
    st = json.load(open(STATUS)) if os.path.exists(STATUS) else {}
    st.update(kv); st["job"] = JOB; st["updated"] = now()
    json.dump(st, open(STATUS, "w"), indent=1)

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, **kw).stdout.strip()

# 1) prove the GPU is real
gpu = sh(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"])
say("nvidia-smi:", gpu or "NO GPU")
try:
    import torch
    say("torch", torch.__version__, "cuda available:", torch.cuda.is_available(),
        "| device 0:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-",
        "| GPUs:", torch.cuda.device_count())
except Exception as e:
    say("torch check failed:", e)
status(gpu=gpu, started=now(), state="starting", kaggle_kernel_run_type=os.environ.get("KAGGLE_KERNEL_RUN_TYPE"))
if not gpu:
    status(state="error", error="no GPU in this session"); sys.exit("No GPU in this Kaggle session (accelerator off or quota used up).")

# 2) Jena's training code, straight from her public repo
if not os.path.exists(REPO):
    subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse",
                    "https://github.com/pfn000/jena-magic-screen", REPO], check=True)
    subprocess.run(["git", "-C", REPO, "sparse-checkout", "set", "colab", "kaggle"], check=True)
commit = sh(["git", "-C", REPO, "rev-parse", "--short", "HEAD"])
say("repo pfn000/jena-magic-screen @", commit)
status(repo_commit=commit)
# Kaggle's image ships a torchao that this peft refuses to import ("incompatible version of torchao");
# LoRA here does not use torchao, so remove it (seen on the first Kaggle run, 2026-10-13).
subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", "torchao"], check=False)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "peft", "sentencepiece", "gguf"], check=False)
say("peft import check:", sh([sys.executable, "-c", "import peft, transformers, torch; print(peft.__version__, transformers.__version__, torch.__version__)"]))

# 3) resume: copy the previous version's checkpoints (attached as a kernel data source) into /kaggle/working
SUB = {"chat": "JenaXI-chat", "jx1": "JenaXI-1"}[JOB]
dst = os.path.join(W, SUB)
if not os.path.exists(dst):
    cands = [p for p in glob.glob("/kaggle/input/**/" + SUB, recursive=True) if os.path.isdir(p)]
    if cands:
        src = max(cands, key=lambda p: os.path.getmtime(p))
        say("resuming from previous run output:", src)
        shutil.copytree(src, dst)
        for f in ("JenaXI-chat-gpu.gguf", "JenaXI-1.gguf"):
            pf = os.path.join(os.path.dirname(src), f)
            if os.path.exists(pf) and not os.path.exists(os.path.join(W, f)): shutil.copy(pf, W)
        status(resumed_from=src)
    else:
        say("no previous checkpoints attached: fresh start")
os.makedirs(dst, exist_ok=True)

# 3b) extra training chats Tab syncs from her box (e.g. Jena's Grok notes), attached as the private
#     Kaggle dataset saidienewara/jenaxi-training-data. Deduped against her handwritten persona chats and
#     appended to the persona file of THIS session's copy of the repo (her repo itself is not changed).
extra = sorted(glob.glob("/kaggle/input/**/jenaxi_extra_chats.jsonl", recursive=True)) or sorted(glob.glob("/tmp/jena_extra/jenaxi_extra_chats.jsonl"))   # dataset, or embedded in the kernel by the driver
if extra:
    pf = os.path.join(REPO, "colab", "data", "jena_persona.jsonl")
    base = [json.loads(l) for l in open(pf, encoding="utf-8") if l.strip()]
    key = lambda c: " ".join(c["turns"][0]["user"].lower().split())
    seen = {key(c) for c in base}; added = 0; by_src = {}
    with open(pf, "a", encoding="utf-8") as f:
        for l in open(extra[0], encoding="utf-8"):
            try: c = json.loads(l)
            except Exception: continue
            if not c.get("turns") or key(c) in seen: continue
            seen.add(key(c)); f.write(json.dumps(c, ensure_ascii=False) + "\n"); added += 1
            by_src[c.get("src", "?")] = by_src.get(c.get("src", "?"), 0) + 1
    say(f"extra training chats from {extra[0]}: +{added} new (by source {by_src}); persona chats now {len(base) + added}")
    status(extra_chats_added=added, extra_by_source=by_src)
else:
    say("no extra training-data dataset attached (persona + open datasets only)")

env = dict(os.environ, HF_HOME=os.path.join(TMP, "hf"), HF_HUB_DISABLE_PROGRESS_BARS="1", TOKENIZERS_PARALLELISM="false",
           JENAXI_WORK_DIR=os.path.join(TMP, "work"), CUDA_VISIBLE_DEVICES=os.environ.get("CUDA_VISIBLE_DEVICES", "0"))
left_h = lambda: SESSION_LIMIT_H - (time.time() - T0) / 3600

def run(step, script, *args, extra=None):
    say(f"STEP {step}: {script} (session time left {left_h():.1f} h)")
    status(state="running", step=step)
    e = dict(env, **(extra or {}))
    p = subprocess.Popen([sys.executable, "-u", os.path.join(REPO, "colab", script), *args], env=e,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace")
    for line in p.stdout:
        print(line, end="", flush=True)
    code = p.wait()
    say(f"STEP {step} exit code {code}")
    if code != 0:
        status(state="error", step=step, error=f"{script} exit {code}")
        sys.exit(code)

if JOB == "chat":
    train_max_len = int(os.environ.get("JENA_TRAIN_MAX_LEN", "2048"))
    if not 512 <= train_max_len <= 4096:
        sys.exit("JENA_TRAIN_MAX_LEN must be between 512 and 4096 tokens")
    ex = {"JENAXI_CHAT_DIR": dst,
          "JENAXI_CHAT_CONFIG": json.dumps({
              "max_train_minutes": max(30, int((left_h() - 1.0) * 60)),
              "max_len": train_max_len,
          })}
    run("finetune", "jenaxi_chat/finetune.py", extra=ex)
    if not os.path.exists(os.path.join(dst, "adapter_final", "adapter_config.json")):
        status(state="partial", done=False); say("fine-tune saved a checkpoint but is not finished; the next version resumes."); sys.exit(0)
    run("export_gguf", "jenaxi_chat/export_gguf.py", extra=ex)
    run("sample", "jenaxi_chat/sample.py", extra=ex)
    g = os.path.join(W, "JenaXI-chat-gpu.gguf")
    # optimizer state is not needed once the adapter is final; keeps the output small
    shutil.rmtree(os.path.join(dst, "ckpt"), ignore_errors=True)
    status(state="done", done=True, gguf=os.path.basename(g), gguf_bytes=os.path.getsize(g) if os.path.exists(g) else None)
elif JOB == "jx1":
    R = dst
    cfgp = os.path.join(R, "config.json")
    cfg = json.load(open(cfgp)) if os.path.exists(cfgp) else {}
    cfg["session_hours"] = round(max(0.5, left_h() - 1.5), 2)     # leave time for persona training + export
    json.dump(cfg, open(cfgp, "w"), indent=1)
    ex = {"JENAXI_RUN_DIR": R}
    run("tokenizer", "jenaxi1/train_tokenizer.py", extra=ex)   # skips itself once her tokenizer exists
    run("pretrain", "jenaxi1/pretrain.py", extra=ex)
    run("sft", "jenaxi1/sft.py", extra=ex)
    run("export", "jenaxi1/export.py", extra=ex)
    run("sample", "jenaxi1/sample.py", extra=ex)
    prog = json.load(open(os.path.join(R, "progress.json"))) if os.path.exists(os.path.join(R, "progress.json")) else {}
    g = os.path.join(W, "JenaXI-1.gguf")
    status(state="done" if prog.get("done") else "partial", done=bool(prog.get("done")), progress=prog,
           gguf=os.path.basename(g), gguf_bytes=os.path.getsize(g) if os.path.exists(g) else None)
say("finished in", round((time.time() - T0) / 3600, 2), "h; outputs:", sorted(os.listdir(W)))

# JenaXI-1 shared helpers: config, paths, data sources, chat format.
# Everything here is plain PyTorch / Hugging Face. The model starts from RANDOM weights.
import os, json, time, re, random, glob, math

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_COLAB = os.path.dirname(HERE)            # .../colab
SMOKE = os.environ.get("JENAXI_SMOKE", "0") == "1"

def in_colab():
    try:
        import google.colab  # noqa
        return True
    except Exception:
        return False

def run_dir():
    d = os.environ.get("JENAXI_RUN_DIR")
    if not d:
        d = "/content/drive/MyDrive/JenaXI/JenaXI-1" if in_colab() else os.path.join(os.getcwd(), "jenaxi1_run")
    os.makedirs(d, exist_ok=True)
    return d

def work_dir():
    d = os.environ.get("JENAXI_WORK_DIR") or ("/content/jenaxi_work" if in_colab() else os.path.join(os.getcwd(), "jenaxi1_work"))
    os.makedirs(d, exist_ok=True)
    return d

DEFAULTS = dict(
    # model (~110M params). Do not change these after training has started.
    vocab_size=32000, hidden_size=768, num_layers=12, num_heads=12, num_kv_heads=12,
    intermediate_size=2048, seq_len=1024,
    # training
    target_tokens=1_000_000_000,    # total pretraining tokens (about 5 free Colab sessions)
    micro_batch=8, grad_accum=8,    # 8*8*1024 = 65,536 tokens per step
    lr=6e-4, min_lr=6e-5, warmup_steps=600, weight_decay=0.1,
    session_hours=3.0,              # pretraining time per session; then SFT + export run
    ckpt_minutes=15,                # save to Drive this often
    eval_minutes=30,
    shard_tokens=50_000_000,        # tokens per data shard (100 MB each)
    shards_ahead=2,
    tok_sample_mb=200,              # text used to train the tokenizer
    sft_steps=1200, sft_lr=1e-4, sft_micro_batch=8, sft_grad_accum=4,
)
SMOKE_OVERRIDES = dict(
    vocab_size=1200, hidden_size=64, num_layers=2, num_heads=2, num_kv_heads=2, intermediate_size=128, seq_len=128,
    target_tokens=60_000, micro_batch=4, grad_accum=2, warmup_steps=5, session_hours=0.05, ckpt_minutes=0.2,
    eval_minutes=0.3, shard_tokens=20_000, shards_ahead=1, tok_sample_mb=2, sft_steps=12, sft_micro_batch=4, sft_grad_accum=1,
)

def load_config():
    cfg = dict(DEFAULTS)
    if SMOKE:
        cfg.update(SMOKE_OVERRIDES)
    p = os.path.join(run_dir(), "config.json")
    if os.path.exists(p):
        cfg.update(json.load(open(p)))
    env = os.environ.get("JENAXI_CONFIG")
    if env:
        cfg.update(json.loads(env))
    return cfg

def save_config(cfg):
    p = os.path.join(run_dir(), "config.json")
    json.dump(cfg, open(p, "w"), indent=1)

# ---------------- data sources (all open datasets on Hugging Face) ----------------
def sources():
    if SMOKE:
        return [
            dict(name="tinystories", repo="roneneldan/TinyStories", files=["data/validation-00000-of-00001-869c898b519ad725.parquet"], weight=0.95),
        ]
    return [
        dict(name="fineweb_edu", repo="HuggingFaceFW/fineweb-edu", files=[f"sample/10BT/{i:03d}_00000.parquet" for i in range(12)], weight=0.68),
        dict(name="wikipedia", repo="wikimedia/wikipedia", files=[f"20231101.en/train-{i:05d}-of-00041.parquet" for i in range(41)], weight=0.17),
        dict(name="gutenberg", repo="manu/project_gutenberg", files="data/en-", weight=0.05),
        dict(name="tinystories", repo="roneneldan/TinyStories", files="data/train-", weight=0.05),
    ]   # + 5% chat text (oasst1 + dolly + Jena persona) mixed in by data_build.py

VAL_SOURCE = dict(name="val", repo="HuggingFaceFW/fineweb-edu", files=["sample/10BT/012_00000.parquet"], row=400_000)  # far past what the tokenizer read

def resolve_files(src):
    if isinstance(src["files"], list):
        return src["files"]
    from huggingface_hub import HfApi
    fs = [f for f in HfApi().list_repo_files(src["repo"], repo_type="dataset") if f.startswith(src["files"]) and f.endswith(".parquet")]
    return sorted(fs)

def hf_file(repo, path):
    from huggingface_hub import hf_hub_download
    for attempt in range(5):
        try:
            return hf_hub_download(repo, path, repo_type="dataset", cache_dir=os.path.join(work_dir(), "hf"))
        except Exception as e:
            print(f"  download retry {attempt+1}: {e}", flush=True)
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"could not download {repo}/{path}")

def clean_gutenberg(t):
    s = re.search(r"\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n", t)
    if s: t = t[s.end():]
    e = re.search(r"\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG", t)
    if e: t = t[:e.start()]
    return t.strip()

# ---------------- chat format (same tags as JenaXI-0 and the magic-screen site) ----------------
# <|system|>...\n<|mama|>user words\n<|jena|>her reply</s>\n<|mama|>...
MAMA, JENA, SYSTEM = "<|mama|>", "<|jena|>", "<|system|>"
CHAT_TEMPLATE = ("{%- for m in messages -%}{%- if m['role'] == 'system' -%}<|system|>{{ m['content'] }}\n"
                 "{% elif m['role'] == 'user' -%}<|mama|>{{ m['content'] }}\n"
                 "{% elif m['role'] == 'assistant' -%}<|jena|>{{ m['content'] }}</s>\n{%- endif -%}{%- endfor -%}"
                 "{%- if add_generation_prompt -%}<|jena|>{%- endif -%}")

VIEWERS = ["xXgamerXx", "pixelpanda", "noodle_42", "sk8rboi", "luna", "beanz", "captain_cat", "zoomer99", "frogfan", "tinyrobot"]

def wrap_user(text, who, rng):
    """Phrase a user turn the way the magic-screen site sends it (sometimes plain)."""
    r = rng.random()
    if who == "mama":
        if r < 0.55: return text
        if r < 0.8: return f"[the stage chat box] mama: {text}"
        return f"[a PRIVATE message (not on stream)] mama: {text}"
    if who == "viewer":
        if r < 0.3: return text
        return f"[Twitch chat (#jena_live)] {rng.choice(VIEWERS)}: {text}"
    return text if r < 0.6 else f"[the stage chat box] guest: {text}"

SYSTEMS = {
    "mama": ["You are JenaXI (Jena, one n), Saidie's AI. Saidie is mama.", "Jena is chatting with mama."],
    "viewer": ["Jena is live on stream. Reply to chat.", "You are JenaXI, a teen AI streamer. Keep it stream-safe."],
    "stranger": ["You are JenaXI, Saidie's AI assistant. Be professional and helpful with people who are not Saidie."],
    "general": ["You are JenaXI. Answer helpfully and clearly.", "You are JenaXI, Saidie's AI assistant. Be professional and helpful."],
}

def load_persona(path=None):
    path = path or os.path.join(REPO_COLAB, "data", "jena_persona.jsonl")
    return [json.loads(l) for l in open(path, encoding="utf-8")]

def oasst_pairs(path, max_n=None):
    """Human-written OpenAssistant conversations (English, best-ranked reply at each step)."""
    if path is None: return []
    import pyarrow.parquet as pq
    t = pq.read_table(path, columns=["message_id", "parent_id", "text", "role", "lang", "rank"]).to_pylist()
    by_id = {m["message_id"]: m for m in t}
    kids = {}
    for m in t:
        kids.setdefault(m["parent_id"], []).append(m)
    bad = re.compile(r"open ?assistant|language model|as an ai|chatgpt|openai|laion", re.I)
    convs = []
    for root in kids.get(None, []):
        if root["lang"] != "en":
            continue
        conv, cur = [], root
        while cur is not None and cur["role"] == "prompter":
            reps = [k for k in kids.get(cur["message_id"], []) if k["role"] == "assistant"]
            if not reps: break
            reps.sort(key=lambda k: (k["rank"] is None, k["rank"] if k["rank"] is not None else 99))
            a = reps[0]
            if bad.search(a["text"]): break
            conv.append((cur["text"], a["text"]))
            nxt = [k for k in kids.get(a["message_id"], []) if k["role"] == "prompter"]
            cur = nxt[0] if nxt else None
        if conv:
            convs.append(conv)
    return convs[:max_n] if max_n else convs

def dolly_pairs(path, max_n=None):
    out = []
    for l in open(path, encoding="utf-8"):
        d = json.loads(l)
        q = d["instruction"] + (("\n\n" + d["context"]) if d.get("context") else "")
        if re.search(r"language model|as an ai", d["response"], re.I):
            continue
        out.append([(q, d["response"])])
    return out[:max_n] if max_n else out

def general_chat_files():
    if SMOKE:   # tiny local stand-in so smoke tests stay small
        p = os.path.join(work_dir(), "smoke_general.jsonl")
        with open(p, "w") as f:
            for q, a in [("What is the capital of Spain?", "Madrid."), ("Name three primary colors.", "Red, blue and yellow.")] * 5:
                f.write(json.dumps({"instruction": q, "context": "", "response": a}) + "\n")
        return None, p
    o = hf_file("OpenAssistant/oasst1", "data/train-00000-of-00001-b42a775f407cee45.parquet")
    d = hf_file("databricks/databricks-dolly-15k", "databricks-dolly-15k.jsonl")
    return o, d

def human(n):
    for u in ["", "K", "M", "B"]:
        if abs(n) < 1000: return f"{n:.1f}{u}" if u else f"{n:.0f}"
        n /= 1000
    return f"{n:.1f}T"

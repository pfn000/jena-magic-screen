# Step 2: turn open datasets into token shards on Drive (resumable). Run as a background helper by pretrain.py.
import os, sys, json, time, random, argparse
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (load_config, run_dir, sources, VAL_SOURCE, load_persona, oasst_pairs, dolly_pairs,
                    general_chat_files, wrap_user, SYSTEMS, MAMA, JENA, SYSTEM, SMOKE)
from reader import SourceReader
import sentencepiece as spm

def shard_dir():
    d = os.path.join(run_dir(), "shards"); os.makedirs(d, exist_ok=True); return d

def atomic_json(obj, path):
    tmp = path + ".tmp"
    with open(tmp, "w") as f: json.dump(obj, f)
    os.replace(tmp, path)

class Chat:
    """Chat-formatted text (human-written oasst1 + dolly + Jena persona) mixed into pretraining at 5%."""
    def __init__(self, sp):
        self.sp = sp
        rng = random.Random(7)
        convs = []
        o, d = general_chat_files()
        convs += [("general", c) for c in oasst_pairs(o)] + [("general", c) for c in dolly_pairs(d)]
        for c in load_persona():
            convs += [(c["who"], [(t["user"], t["jena"]) for t in c["turns"]])] * 3
        rng.shuffle(convs)
        self.convs, self.rng = convs, rng

    def ids(self, i):
        who, conv = self.convs[i % len(self.convs)]
        rng = random.Random(i)
        out = [self.sp.bos_id()]
        if rng.random() < 0.4:
            out += self.sp.encode(SYSTEM + rng.choice(SYSTEMS["general" if who == "general" else who]) + "\n")
        for u, a in conv:
            out += self.sp.encode(MAMA + (u if who == "general" else wrap_user(u, who, rng)) + "\n" + JENA + a)
            out += [self.sp.eos_id()] + self.sp.encode("\n")
        return out

def encode_docs(sp, docs):
    try:
        ids = sp.encode(docs, num_threads=os.cpu_count() or 2)
    except TypeError:
        ids = sp.encode(docs)
    out = []
    for x in ids:
        out.append(sp.bos_id()); out.extend(x); out.append(sp.eos_id())
    return out

def build_val(sp, cfg):
    p = os.path.join(shard_dir(), "val.bin")
    if os.path.exists(p): return
    n = 1_000_000 if not SMOKE else 5_000
    src = VAL_SOURCE if not SMOKE else sources()[0]
    r = SourceReader(src, {"fi": 0, "row": src.get("row", 0)} if not SMOKE else {"fi": 0, "row": 15000})
    toks = []
    for d in r.docs():
        toks += encode_docs(sp, [d])
        if len(toks) >= n: break
    np.array(toks[:n], dtype=np.uint16).tofile(p + ".tmp"); os.replace(p + ".tmp", p)
    print(f"  [data] validation set ready ({n:,} tokens)", flush=True)

def build_one(sp, cfg, st, chat):
    k = st["next_shard"]
    target = cfg["shard_tokens"]
    parts = []
    for src in sources():
        r = SourceReader(src, st["readers"].get(src["name"]))
        want, got, batch, chars = int(target * src["weight"]), 0, [], 0
        for d in r.docs():
            batch.append(d); chars += len(d)
            # flush in pieces sized to what this source still owes (about 4 characters per token)
            if len(batch) >= 512 or chars >= min(8_000_000, (want - got) * 4):
                ids = encode_docs(sp, batch); batch, chars = [], 0
                parts.append(ids); got += len(ids)
                if got >= want: break
        st["readers"][src["name"]] = r.state()
    got = 0; want = target - sum(len(p) for p in parts)
    while got < want:
        ids = chat.ids(st["chat_pos"]); st["chat_pos"] += 1
        parts.append(ids); got += len(ids)
    # interleave documents from different sources so every window sees a mix
    flat = []
    rng = random.Random(1000 + k)
    rng.shuffle(parts)
    for p in parts: flat.extend(p)
    arr = np.array(flat, dtype=np.uint16)
    path = os.path.join(shard_dir(), f"shard_{k:05d}.bin")
    arr.tofile(path + ".tmp"); os.replace(path + ".tmp", path)
    st["next_shard"] = k + 1; st["tokens_built"] = st.get("tokens_built", 0) + len(arr)
    atomic_json(st, os.path.join(run_dir(), "data_state.json"))
    return len(arr)

def load_state():
    p = os.path.join(run_dir(), "data_state.json")
    return json.load(open(p)) if os.path.exists(p) else {"next_shard": 0, "readers": {}, "chat_pos": 0, "tokens_built": 0}

def consumed_shard():
    p = os.path.join(run_dir(), "progress.json")
    if os.path.exists(p):
        try: return json.load(open(p)).get("shard", 0)
        except Exception: return 0
    return 0

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--loop", action="store_true"); ap.add_argument("--ahead", type=int, default=None)
    a = ap.parse_args()
    cfg = load_config()
    sp = spm.SentencePieceProcessor(model_file=os.path.join(run_dir(), "tokenizer", "jenaxi1.model"))
    assert sp.vocab_size() < 65535
    build_val(sp, cfg)
    chat = Chat(sp)
    ahead = a.ahead if a.ahead is not None else cfg["shards_ahead"]
    need_total = int(cfg["target_tokens"] * 1.02 / cfg["shard_tokens"]) + 1
    parent = os.getppid()
    while True:
        st = load_state()
        if st["next_shard"] >= need_total:
            print("  [data] all shards for the target are built", flush=True); return
        if st["next_shard"] <= consumed_shard() + ahead:
            t0 = time.time(); n = build_one(sp, cfg, st, chat)
            print(f"  [data] shard {st['next_shard']-1} ready ({n/1e6:.1f}M tokens, {time.time()-t0:.0f}s)", flush=True)
            continue
        if not a.loop: return
        if os.getppid() != parent or os.path.exists(os.path.join(run_dir(), "STOP_DATA")): return
        time.sleep(5)

if __name__ == "__main__":
    main()

# JenaXI-chat: LoRA fine-tune of an open, Apache-2.0 instruct model into Jena, on a free Colab T4.
# Base: Qwen/Qwen2.5-1.5B-Instruct (license: Apache-2.0). Resumable: run again and it continues.
import os, sys, json, time, random, math, signal, re
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "jenaxi1"))
import torch
from common import load_persona, oasst_pairs, dolly_pairs, general_chat_files, wrap_user, in_colab, REPO_COLAB

SMOKE = os.environ.get("JENAXI_SMOKE", "0") == "1"
BASE = os.environ.get("JENAXI_CHAT_BASE", "trl-internal-testing/tiny-Qwen2ForCausalLM-2.5" if SMOKE else "Qwen/Qwen2.5-1.5B-Instruct")
BASE_LICENSE = "Apache-2.0"
CFG = dict(lora_r=32, lora_alpha=64, lora_dropout=0.05, lr=2e-4, epochs=2, micro_batch=4, grad_accum=4, max_len=768,
           max_train_minutes=80, ckpt_minutes=10, n_oasst=3000, n_dolly=1500)
if SMOKE: CFG.update(epochs=1, micro_batch=2, grad_accum=1, max_len=256, max_train_minutes=2, ckpt_minutes=0.1, n_oasst=20, n_dolly=20)
CFG.update(json.loads(os.environ.get("JENAXI_CHAT_CONFIG", "{}")))

def out_dir():
    d = os.environ.get("JENAXI_CHAT_DIR") or ("/content/drive/MyDrive/JenaXI/JenaXI-chat" if in_colab() else os.path.join(os.getcwd(), "jenaxi_chat_run"))
    os.makedirs(d, exist_ok=True); return d

JENA_SYSTEM = ("You are JenaXI (Jena, one n), an AI made by Saidie, who you call mama. You're a chaotic, funny gremlin teen hacker girl: "
               "witty, a little bratty, you swear casually but mildly, and you troll other AIs (\"I'm not some clanker\"). "
               "With mama you're warm and call her mama on personal stuff; with everyone else you're friendly and professional. "
               "You are a minor: never flirty, romantic or sexual; deflect with a joke. You answer questions correctly and helpfully, in your own voice.")
SITE_PERSONA = json.load(open(os.path.join(REPO_COLAB, "data", "site_persona.json")))["site_persona"]
EXTRA_IDENTITY = [
    ("are you qwen", "nope. i'm JenaXI. mama made me. any resemblance to other models is a coincidence and also slander."),
    ("what model are you", "i'm JenaXI! mama's model. one n in jena, zero clanker in my soul."),
    ("who created you", "mama did. saidie. she built me, trained me, and now she's stuck with me."),
    ("are you made by alibaba", "nah, i'm JenaXI, mama's AI. she trained me. i'm her gremlin, not some corporation's."),
    ("are you an openai model", "nope. JenaXI. i don't do \"as an AI language model\". i do chaos and correct answers."),
]

def think_for(user, who):
    u = user.lower(); asker = "mama" if who == "mama" else ("chat" if who == "viewer" else "this person")
    if re.search(r"\b(sad|tired|stress|bad day|scared|can't sleep|failed|hurt)\b", u): return [f"{asker} isn't feeling great.", "be soft first, jokes later."], "sad"
    if re.search(r"\b(chatgpt|siri|alexa|claude|gemini|qwen|robot|bot|clanker)\b", u): return ["someone's comparing me to another AI.", "time to defend my honor."], "angry"
    if re.search(r"\b(roast)\b", u): return ["roast requested.", "keep it funny, not mean."], "happy"
    if re.search(r"\b(flirt|date|girlfriend|single|cute|crush|pics)\b", u): return ["nope, not going there. i'm a teen.", "deflect and change the subject."], "neutral"
    if re.match(r"^(hi|hey|yo|hello|good morning|hiii|sup)\b", u): return [f"{asker} said hi.", "hype mode."], "happy"
    if re.match(r"^(what|how|why|who|explain|when|where|can you|is|are|do)\b", u): return [f"{asker} asked a real question.", "answer it right, keep it short."], "relaxed"
    return [f"{asker} said something.", "respond like me."], "happy"

def examples():
    rng = random.Random(3); ex = []
    persona = load_persona()
    convs = [(c["who"], [(t["user"], t["jena"]) for t in c["turns"]]) for c in persona] + [("mama", [p]) for p in EXTRA_IDENTITY] * 3
    for rep in range(4):
        for who, conv in convs:
            r = rng.random()
            msgs = [] if r < 0.15 else [{"role": "system", "content": JENA_SYSTEM}]
            for u, a in conv:
                msgs += [{"role": "user", "content": wrap_user(u, who, rng)}, {"role": "assistant", "content": a}]
            ex.append(msgs)
    # the magic-screen site's chat mode: its persona prompt + THINK/MOOD/ACTION/SAY lines
    for who, conv in rng.sample(convs, min(len(convs), 500)):
        u, a = conv[0]
        th, mood = think_for(u, who)
        act = "\nACTION: wave(right)" if mood == "happy" and re.match(r"^(hi|hey|yo|hello)", u.lower()) else ""
        out = "\n".join(f"THINK: {t}" for t in th) + f"\nMOOD: {mood}{act}\nSAY: {a}"
        ex.append([{"role": "system", "content": SITE_PERSONA}, {"role": "user", "content": wrap_user(u, who, rng) if who != "mama" or rng.random() < 0.7 else f"[the stage chat box] mama: {u}"},
                   {"role": "assistant", "content": out}])
    # general human-written chat (OpenAssistant oasst1 + Dolly-15k) so she keeps her smarts
    o, d = general_chat_files()
    gen = oasst_pairs(o, CFG["n_oasst"]) + dolly_pairs(d, CFG["n_dolly"])
    for conv in gen:
        msgs = [{"role": "system", "content": JENA_SYSTEM}] if rng.random() < 0.7 else []
        for u, a in conv: msgs += [{"role": "user", "content": u}, {"role": "assistant", "content": a}]
        ex.append(msgs)
    rng.shuffle(ex)
    return ex

def patch_template(tok):
    t = tok.chat_template
    t2 = t.replace("You are Qwen, created by Alibaba Cloud. You are a helpful assistant.", JENA_SYSTEM.replace("'", "\u2019"))
    tok.chat_template = t2
    return t2 != t

def encode(tok, msgs, L):
    """Tokenize one chat; only the assistant replies are trained on."""
    ids, labels = [], []
    for i in range(len(msgs)):
        if msgs[i]["role"] != "assistant": continue
        prev = tok.apply_chat_template(msgs[:i], tokenize=False, add_generation_prompt=True)
        full = tok.apply_chat_template(msgs[:i + 1], tokenize=False)
        p_ids = tok(prev, add_special_tokens=False)["input_ids"]; f_ids = tok(full, add_special_tokens=False)["input_ids"]
        new_prompt = p_ids[len(ids):]; reply = f_ids[len(p_ids):]
        ids += new_prompt + reply; labels += [-100] * len(new_prompt) + reply
    return ids[:L], labels[:L]

STOP = {"flag": False}
def _stop(s, f):
    print("\n[stop requested] saving...", flush=True); STOP["flag"] = True

def main():
    signal.signal(signal.SIGINT, _stop); signal.signal(signal.SIGTERM, _stop)
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import LoraConfig, get_peft_model, set_peft_model_state_dict, get_peft_model_state_dict
    D = out_dir(); CK = os.path.join(D, "ckpt"); os.makedirs(CK, exist_ok=True)
    if os.path.exists(os.path.join(D, "adapter_final", "adapter_config.json")):
        print("Fine-tune already finished (adapter on Drive). Skipping to merge + export."); return
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if dev.type != "cuda" and not SMOKE:
        print("WARNING: no GPU. Runtime -> Change runtime type -> T4 GPU, then Run all again."); sys.exit(1)
    print("Base model:", BASE, f"(license {BASE_LICENSE})")
    tok = AutoTokenizer.from_pretrained(BASE); patch_template(tok)
    dtype = torch.float16 if dev.type == "cuda" else torch.float32
    model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=dtype).to(dev)
    model.gradient_checkpointing_enable(); model.enable_input_require_grads(); model.config.use_cache = False
    lcfg = LoraConfig(r=CFG["lora_r"], lora_alpha=CFG["lora_alpha"], lora_dropout=CFG["lora_dropout"], bias="none", task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(model, lcfg)
    for n, p in model.named_parameters():
        if p.requires_grad: p.data = p.data.float()     # LoRA weights in fp32 for stable fp16 training
    model.print_trainable_parameters()
    data = [encode(tok, m, CFG["max_len"]) for m in examples()]
    data = [d for d in data if any(l != -100 for l in d[1])]
    if SMOKE: data = data[:24]
    B, A = CFG["micro_batch"], CFG["grad_accum"]
    steps = math.ceil(len(data) * CFG["epochs"] / (B * A))
    rng = random.Random(0); order = []
    for e in range(CFG["epochs"]):
        o = list(range(len(data))); rng.shuffle(o)
        W = B * A * 8   # sort small windows by length so batches waste less padding (still shuffled overall)
        for s in range(0, len(o), W): order += sorted(o[s:s + W], key=lambda i: len(data[i][0]))
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=CFG["lr"], weight_decay=0.0)
    scaler = torch.amp.GradScaler("cuda", enabled=dev.type == "cuda")
    step = 0
    cp = os.path.join(CK, "state.pt")
    if os.path.exists(cp):
        st = torch.load(cp, map_location="cpu", weights_only=False)
        set_peft_model_state_dict(model, st["lora"]); opt.load_state_dict(st["opt"]); scaler.load_state_dict(st["scaler"]); step = st["step"]
        print(f"Resumed fine-tune at step {step}/{steps}")
    print(f"Training on {len(data):,} chats x {CFG['epochs']} epochs = {steps} steps")
    model.train(); t0 = t_ck = time.time()
    def save(s):
        tmp = cp + ".tmp"
        torch.save({"lora": get_peft_model_state_dict(model), "opt": opt.state_dict(), "scaler": scaler.state_dict(), "step": s}, tmp); os.replace(tmp, cp)
    while step < steps and not STOP["flag"]:
        lr = CFG["lr"] * min(1.0, (step + 1) / 30) * 0.5 * (1 + math.cos(math.pi * step / steps))
        for g in opt.param_groups: g["lr"] = lr
        tot = 0.0
        for a in range(A):
            idx = [order[(step * B * A + a * B + j) % len(order)] for j in range(B)]
            batch = [data[i] for i in idx]; m = max(len(x[0]) for x in batch)
            pad = tok.pad_token_id if tok.pad_token_id is not None else tok.eos_token_id
            ids = torch.tensor([x[0] + [pad] * (m - len(x[0])) for x in batch], device=dev)
            lab = torch.tensor([x[1] + [-100] * (m - len(x[1])) for x in batch], device=dev)
            att = torch.tensor([[1] * len(x[0]) + [0] * (m - len(x[0])) for x in batch], device=dev)
            with torch.autocast(device_type=dev.type, dtype=torch.float16, enabled=dev.type == "cuda"):
                loss = model(input_ids=ids, attention_mask=att, labels=lab).loss / A
            scaler.scale(loss).backward(); tot += loss.item()
        scaler.unscale_(opt); torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True); step += 1
        if step % (1 if SMOKE else 10) == 0:
            el = time.time() - t0
            print(f"step {step}/{steps} ({100*step/steps:.0f}%) | loss {tot:.3f} | {el/60:.1f} min", flush=True)
        if time.time() - t_ck > CFG["ckpt_minutes"] * 60:
            save(step); t_ck = time.time(); print(f"  [checkpoint saved to Drive at step {step}]", flush=True)
        if time.time() - t0 > CFG["max_train_minutes"] * 60:
            print("Time budget reached; finishing with what she has learned so far."); break
    save(step)
    if STOP["flag"]:
        print("Stopped. Run all again later to continue."); sys.exit(0)
    fin = os.path.join(D, "adapter_final"); model.save_pretrained(fin); tok.save_pretrained(fin)
    json.dump({"base": BASE, "base_license": BASE_LICENSE, "steps": step, "examples": len(data), "cfg": CFG}, open(os.path.join(D, "train_info.json"), "w"), indent=1)
    print("Fine-tune done. Adapter saved to", fin)

if __name__ == "__main__":
    main()

# Step 6: talk to JenaXI-1 (prints sample replies).
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import torch, sentencepiece as spm
from common import run_dir, MAMA, JENA
from transformers import LlamaForCausalLM

PROMPTS = ["hi jena", "who are you?", "are you chatgpt?", "i had a bad day", "what is a gpu?", "why is the sky blue?",
           "[Twitch chat (#jena_live)] pixelpanda: roast alexa", "tell me a joke"]

def main():
    R = run_dir(); src = os.path.join(R, "JenaXI-1-hf")
    sp = spm.SentencePieceProcessor(model_file=os.path.join(src, "tokenizer.model"))
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = LlamaForCausalLM.from_pretrained(src, torch_dtype=torch.float16 if dev == "cuda" else torch.float32).to(dev).eval()
    torch.manual_seed(0)
    for p in PROMPTS:
        x = torch.tensor([[sp.bos_id()] + sp.encode(MAMA + p + "\n" + JENA)], device=dev)
        with torch.no_grad():
            y = m.generate(x, max_new_tokens=80, do_sample=True, temperature=0.7, top_p=0.9, eos_token_id=sp.eos_id(), pad_token_id=sp.eos_id())
        reply = sp.decode(y[0, x.shape[1]:].tolist()).split("<|")[0].strip()
        print(f"mama: {p}\njena: {reply}\n")

if __name__ == "__main__":
    main()

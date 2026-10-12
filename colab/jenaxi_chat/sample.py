# Talk to JenaXI-chat (sample replies from the merged model on the GPU).
import os, sys, torch
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "jenaxi1"))
from common import work_dir
from finetune import JENA_SYSTEM

PROMPTS = [("hi jena", True), ("who are you?", True), ("are you chatgpt?", True), ("i had a really bad day", True),
           ("How does a rocket work?", True), ("write a python function that checks if a number is prime", True),
           ("[Twitch chat (#jena_live)] pixelpanda: roast alexa", True), ("Hello, can I leave a message for Saidie?", False)]

def main():
    from transformers import AutoTokenizer, AutoModelForCausalLM
    p = os.path.join(work_dir(), "JenaXI-chat-merged")
    tok = AutoTokenizer.from_pretrained(p)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = AutoModelForCausalLM.from_pretrained(p, torch_dtype=torch.float16 if dev == "cuda" else torch.float32).to(dev).eval()
    torch.manual_seed(0)
    for q, sys_on in PROMPTS:
        msgs = ([{"role": "system", "content": JENA_SYSTEM}] if sys_on else []) + [{"role": "user", "content": q}]
        x = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)["input_ids"].to(dev)
        with torch.no_grad():
            y = m.generate(x, max_new_tokens=150, do_sample=True, temperature=0.7, top_p=0.9, pad_token_id=tok.eos_token_id)
        print(f"> {q}\njena: {tok.decode(y[0, x.shape[1]:], skip_special_tokens=True).strip()}\n")

if __name__ == "__main__":
    main()

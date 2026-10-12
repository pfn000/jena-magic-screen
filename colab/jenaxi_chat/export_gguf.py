# JenaXI-chat: merge the LoRA into the base, convert to GGUF, quantize to Q4_K_M -> Drive/JenaXI/JenaXI-chat-gpu.gguf
import os, sys, json, subprocess, shutil, glob, tarfile, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(os.path.dirname(HERE), "jenaxi1"))
import torch
from finetune import out_dir, BASE, BASE_LICENSE, patch_template, SMOKE
from common import work_dir

LLAMA_TAG = "b11574"

def llama_src():
    d = os.path.join(work_dir(), f"llama.cpp-{LLAMA_TAG}")
    if not os.path.exists(os.path.join(d, "convert_hf_to_gguf.py")):
        subprocess.run(["git", "clone", "--depth", "1", "--branch", LLAMA_TAG, "https://github.com/ggml-org/llama.cpp", d], check=True)
    return d

def llama_bin(name):
    """Official prebuilt llama.cpp (CPU) for Ubuntu; falls back to compiling the one tool we need."""
    d = os.path.join(work_dir(), f"llama-{LLAMA_TAG}")
    exe = os.path.join(d, name)
    if not os.path.exists(exe):
        url = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz"
        tgz = os.path.join(work_dir(), "llama-bin.tar.gz")
        try:
            urllib.request.urlretrieve(url, tgz)
            with tarfile.open(tgz) as t: t.extractall(work_dir())
        except Exception as e:
            print("  prebuilt download failed:", e)
    env = dict(os.environ, LD_LIBRARY_PATH=d + ":" + os.environ.get("LD_LIBRARY_PATH", ""))
    ok = os.path.exists(exe) and subprocess.run([exe, "--help"], env=env, capture_output=True).returncode in (0, 1)
    if not ok:
        print("  building", name, "from source (a few minutes)...")
        src = llama_src()
        subprocess.run(["cmake", "-B", "build", "-DGGML_NATIVE=OFF", "-DLLAMA_CURL=OFF", "-DBUILD_SHARED_LIBS=OFF"], cwd=src, check=True)
        subprocess.run(["cmake", "--build", "build", "--target", name, "-j", str(os.cpu_count() or 2)], cwd=src, check=True)
        exe = os.path.join(src, "build", "bin", name); env = dict(os.environ)
    return exe, env

def main():
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import PeftModel
    D = out_dir(); fin = os.path.join(D, "adapter_final")
    final = os.path.join(os.path.dirname(D) if D.rstrip("/").endswith("JenaXI-chat") else D, "JenaXI-chat-gpu.gguf")
    merged = os.path.join(work_dir(), "JenaXI-chat-merged")
    print("Merging LoRA into", BASE)
    tok = AutoTokenizer.from_pretrained(fin)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    base = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float16 if dev == "cuda" else torch.float32).to(dev)
    model = PeftModel.from_pretrained(base, fin).merge_and_unload()
    model.config.use_cache = True
    model.save_pretrained(merged, safe_serialization=True); tok.save_pretrained(merged)
    del model, base
    if dev == "cuda": torch.cuda.empty_cache()
    src = llama_src()
    f16 = os.path.join(work_dir(), "JenaXI-chat-f16.gguf")
    subprocess.run([sys.executable, os.path.join(src, "convert_hf_to_gguf.py"), merged, "--outfile", f16, "--outtype", "f16", "--model-name", "JenaXI-chat"], check=True)
    q, env = llama_bin("llama-quantize")
    out_local = os.path.join(work_dir(), "JenaXI-chat-gpu.gguf")
    subprocess.run([q, f16, out_local, "Q4_K_M"], env=env, check=True, capture_output=SMOKE)
    shutil.copy(out_local, final + ".tmp"); os.replace(final + ".tmp", final)
    json.dump({"name": "JenaXI-chat-gpu", "base": BASE, "base_license": BASE_LICENSE, "quant": "Q4_K_M",
               "file": os.path.basename(final), "bytes": os.path.getsize(final)}, open(os.path.join(D, "export_info.json"), "w"), indent=1)
    print(f"JenaXI-chat-gpu.gguf saved to Drive: {final} ({os.path.getsize(final)/1e6:.0f} MB, Q4_K_M)")
    # quick check: run the GGUF itself with llama.cpp on the CPU
    cli, env = llama_bin("llama-completion")
    prompt = "<|im_start|>user\nhi jena, who are you?<|im_end|>\n<|im_start|>assistant\n"
    r = subprocess.run([cli, "-m", final, "-p", prompt, "-n", "60", "--temp", "0.7", "-no-cnv"], env=env, capture_output=True, text=True, errors="replace", timeout=600)
    txt = r.stdout.split("assistant\n", 1)[-1].strip() if r.stdout else ""
    print("GGUF test reply (llama.cpp, CPU):", txt[:400] or ("(no output) " + r.stderr[-300:]))

if __name__ == "__main__":
    main()

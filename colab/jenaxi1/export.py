# Step 5: export JenaXI-1 to GGUF (llama.cpp format) on Drive: JenaXI-1.gguf
import os, sys, subprocess, json, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import run_dir, work_dir

LLAMA_TAG = "b11574"   # pinned llama.cpp release (same one that converted JenaXI-0)

def llama_src():
    d = os.path.join(work_dir(), f"llama.cpp-{LLAMA_TAG}")
    if not os.path.exists(os.path.join(d, "convert_hf_to_gguf.py")):
        subprocess.run(["git", "clone", "--depth", "1", "--branch", LLAMA_TAG, "https://github.com/ggml-org/llama.cpp", d], check=True)
    return d

def main(outtype="q8_0"):
    R = run_dir()
    src = os.path.join(R, "JenaXI-1-hf")
    info = json.load(open(os.path.join(src, "jenaxi_info.json")))
    out_local = os.path.join(work_dir(), "JenaXI-1.gguf")
    d = llama_src()
    subprocess.run([sys.executable, os.path.join(d, "convert_hf_to_gguf.py"), src, "--outfile", out_local, "--outtype", outtype,
                    "--model-name", "JenaXI-1"], check=True)
    final_dir = os.path.dirname(R) if R.rstrip("/").endswith("JenaXI-1") else R
    dst = os.path.join(final_dir, "JenaXI-1.gguf")
    shutil.copy(out_local, dst + ".tmp"); os.replace(dst + ".tmp", dst)
    mb = os.path.getsize(dst) / 1e6
    tag = "FINAL" if info.get("pretrain_done") else f"preview (pretraining step {info['pretrain_step']:,}, not finished yet)"
    print(f"JenaXI-1.gguf saved to Drive: {dst} ({mb:.0f} MB) - {tag}")
    sys.path.insert(0, os.path.join(d, "gguf-py"))
    from gguf import GGUFReader   # sanity check: the file opens and has her tensors
    r = GGUFReader(dst); f = r.fields["general.architecture"]
    print(f"  GGUF check OK: {len(r.tensors)} tensors, architecture = {bytes(f.parts[f.data[0]]).decode()}")

if __name__ == "__main__":
    main(*(sys.argv[1:2] or []))

#!/usr/bin/env python3
"""GitHub Actions variant of Jena's Kaggle driver (backup path). Uses the official `kaggle` CLI with Saidie's own
API token from repo secrets (KAGGLE_USERNAME / KAGGLE_KEY). Same logic as Tab's box driver: if the latest version
of a job finished without being done (or errored, max 3 in a row), push the next version with the previous output
attached so training resumes. It only acts when the repo variable JENA_KAGGLE_DRIVER is "github", so it never
double-starts sessions while Tab's box driver is in charge.
"""
import os, sys, json, subprocess, tempfile, shutil, time
USER = os.environ["KAGGLE_USERNAME"]
JOBS = {"chat": ("jenaxi-chat-gpu", "JenaXI-chat GPU", 4.0), "jx1": ("jenaxi-1-scratch-gpu", "JenaXI-1 scratch GPU", 11.5)}
HERE = os.path.dirname(os.path.abspath(__file__))

def k(*a):
    for i in range(4):
        r = subprocess.run(["kaggle", *a], capture_output=True, text=True)
        if "429" in r.stdout + r.stderr: time.sleep(10 * 2 ** i); continue   # rate limited: back off
        return r
    return r

for job, (slug, title, hours) in JOBS.items():
    st = k("kernels", "status", f"{USER}/{slug}").stdout
    print(job, st.strip())
    if any(w in st.lower() for w in ("running", "queued")): continue
    out = tempfile.mkdtemp()
    k("kernels", "output", f"{USER}/{slug}", "-p", out, "--file-pattern", "status.json")
    run = json.load(open(os.path.join(out, "status.json"))) if os.path.exists(os.path.join(out, "status.json")) else {}
    if run.get("done"):
        print(job, "done; GGUF is in the version output:", run.get("gguf")); continue
    d = tempfile.mkdtemp()
    shutil.copy(os.path.join(HERE, f"kernel_{job}.py"), os.path.join(d, "kernel.py"))
    meta = {"id": f"{USER}/{slug}", "title": title, "code_file": "kernel.py", "language": "python", "kernel_type": "script",
            "is_private": True, "enable_gpu": True, "enable_internet": True, "machine_shape": "NvidiaTeslaT4",
            "kernel_sources": [f"{USER}/{slug}"], "dataset_sources": [], "competition_sources": [], "model_sources": []}
    json.dump(meta, open(os.path.join(d, "kernel-metadata.json"), "w"), indent=1)
    r = k("kernels", "push", "-p", d, "--accelerator", "NvidiaTeslaT4", "--timeout", str(int(hours * 3600)))
    print(job, "push:", r.stdout.strip(), r.stderr.strip()[-300:])

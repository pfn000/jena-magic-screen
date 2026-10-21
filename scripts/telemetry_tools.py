#!/usr/bin/env python3
"""Jena motion telemetry tools (LOCAL). Not run by the site.

  python3 scripts/telemetry_tools.py decode <batch.jtel.gz>        -> prints shape + per-bone jerk peaks
  python3 scripts/telemetry_tools.py hf-upload [--dir D] [--repo R] [--go]
        uploads batches to a PRIVATE Hugging Face dataset. DRY RUN unless --go. Needs HF_TOKEN in env
        (Saidie's HF account; the token lives in Tab's vault, never in this repo). Root decides before any --go.
"""
import gzip, json, os, sys, glob
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
TEL = os.path.join(ROOT, 'jena-avatar', 'animations', 'live-telemetry')

def decode(path):
    schema = json.load(open(os.path.join(TEL, 'schema.json')))
    nb, ne = len(schema['bones']), len(schema['expr']); fl = nb * 4 + 5
    raw = open(path, 'rb').read()
    if path.endswith('.gz'): raw = gzip.decompress(raw)
    per = fl * 2 + ne + 1; n = len(raw) // per
    f = np.frombuffer(raw[: n * fl * 2], dtype=np.float16).astype(np.float32).reshape(n, fl)
    e = np.frombuffer(raw[n * fl * 2: n * fl * 2 + n * ne], dtype=np.uint8).reshape(n, ne) / 255.0
    flags = np.frombuffer(raw[n * fl * 2 + n * ne:], dtype=np.uint8)[:n]
    return dict(quat=f[:, : nb * 4].reshape(n, nb, 4), root=f[:, nb * 4: nb * 4 + 3], gaze=f[:, nb * 4 + 3:], expr=e, flags=flags, bones=schema['bones'], hz=schema['hz'])

def jerk(d):
    q = d['quat']; h = 1.0 / d['hz']
    dot = np.clip(np.abs((q[1:] * q[:-1]).sum(-1)), 0, 1); w = 2 * np.arccos(dot) / h
    j = np.diff(w, n=2, axis=0) / h / h
    return {b: float(np.abs(j[:, i]).max()) for i, b in enumerate(d['bones'])}

def hf_upload(args):
    repo = args[args.index('--repo') + 1] if '--repo' in args else 'jena-motion-telemetry'
    d = args[args.index('--dir') + 1] if '--dir' in args else TEL
    files = sorted(glob.glob(os.path.join(d, '**', '*.jtel*'), recursive=True))
    print(f'{len(files)} batch files under {d} -> private dataset <user>/{repo}')
    if '--go' not in args: print('dry run (add --go to upload; root decides first)'); return
    from huggingface_hub import HfApi
    api = HfApi(token=os.environ['HF_TOKEN']); user = api.whoami()['name']
    api.create_repo(f'{user}/{repo}', repo_type='dataset', private=True, exist_ok=True)
    api.upload_folder(folder_path=d, repo_id=f'{user}/{repo}', repo_type='dataset', path_in_repo='live-telemetry')

if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0] == 'decode':
        d = decode(a[1]); print(d['quat'].shape, 'interpolated', int((d['flags'] & 1).sum()), 'across drops', int(((d['flags'] & 2) > 0).sum()))
        for b, v in sorted(jerk(d).items(), key=lambda x: -x[1])[:10]: print(f'{b:28s} peak jerk {v:9.0f} rad/s^3')
    elif a and a[0] == 'hf-upload': hf_upload(a)
    else: print(__doc__)

#!/usr/bin/env python3
"""Prints matrix=<json> for jena-compute.yml: the one dispatched job, or (schedule) the pending items of
ops/compute/queue.json whose result is not in their release yet (the nightly batch)."""
import json, os, re, subprocess
ev = os.environ.get('EVENT'); items = []
JOBS = {'move_extract', 'mama_session', 'model_job', 'ux_test'}
if ev == 'workflow_dispatch':
    items = [{'job': os.environ['JOB'], 'input': os.environ.get('INPUT', ''), 'params': os.environ.get('PARAMS', ''), 'request_id': os.environ['REQ']}]
else:
    try: q = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'queue.json'))).get('items', [])
    except Exception: q = []
    for it in q:
        tag = f"jena-compute-{it.get('job')}"
        r = subprocess.run(['gh', 'release', 'view', tag, '-R', os.environ['GITHUB_REPOSITORY'], '--json', 'assets', '-q', '.assets[].name'], capture_output=True, text=True)
        if f"{it.get('request_id')}.manifest.json" not in r.stdout.split(): items.append(it)
ok = [i for i in items if i.get('job') in JOBS and re.fullmatch(r'[A-Za-z0-9._-]{3,80}', i.get('request_id', ''))][:8]
print('matrix=' + json.dumps({'include': ok})); print('count=' + str(len(ok)))

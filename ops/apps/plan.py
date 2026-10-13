#!/usr/bin/env python3
"""plan.py <app>: validate an app name against ops/apps/apps.json and print GitHub step outputs."""
import json, os, re, sys
name = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,40}', name): sys.exit(f'bad app name: {name!r}')
apps = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'apps.json')))['apps']
a = apps.get(name)
if not a: sys.exit(f'{name} is not in ops/apps/apps.json')
if not a.get('enabled'): sys.exit(f'{name} is disabled: {a.get("disabled_reason", "")}')
print(f'name={name}'); print(f'platform={a["platform"]}'); print(f'mode={a["mode"]}')

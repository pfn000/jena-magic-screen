# "install <app>" / "what apps are installing?" — Jena's app pipeline (box: ~/jena-apps/installer.py).
# Installs run detached at nice 19; this answers right away. Refuses installs while mama has her desktop.
import os, sys, json, re, subprocess, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '_lib'))
from jenaskill import inp, done
HOME = os.path.expanduser('~')
INSTALLER = os.path.join(HOME, 'jena-apps', 'installer.py')
STATUS = os.path.join(HOME, '.jena', 'apps_status.json')
FLAG = os.path.join(HOME, '.jena', 'mama_takeover.json')
i = inp(); text = (i.get('text') or '').strip(); low = text.lower()

def apps():
    for p in (os.path.join(HOME, 'jena-repo', 'ops', 'apps', 'apps.json'), os.path.join(HOME, 'jena-apps', 'apps.json')):
        try: return json.load(open(p))['apps']
        except Exception: pass
    return {}

def status():
    try: return json.load(open(STATUS))
    except Exception: return {}

WORDS = {'queued': 'waiting its turn', 'building': 'GitHub is building it', 'downloading': 'downloading it', 'installing': 'installing it', 'ready': 'ready', 'failed': 'failed'}
if i.get('test'):
    done(True, 'install_app ok', apps=sorted(apps()))

if re.search(r"\bwhat\b.*\b(installing|setting up|downloading)\b|\bstatus\b|\bwhat apps can\b", low):
    s = status()
    busy = {k: v for k, v in s.items() if v.get('status') in ('queued', 'building', 'downloading', 'installing')}
    if 'can' in low and 'install' in low:
        a = apps(); on = [v.get('title', k) for k, v in a.items() if v.get('enabled')]; off = [v.get('title', k) for k, v in a.items() if not v.get('enabled')]
        done(True, 'i can install: ' + ', '.join(on) + ('. not yet: ' + ', '.join(off) if off else ''), apps=a)
    if not busy:
        ready = [k for k, v in s.items() if v.get('status') == 'ready']
        failed = [f"{k} ({v.get('error')})" for k, v in s.items() if v.get('status') == 'failed']
        msg = 'nothing is installing right now.'
        if ready: msg += ' installed: ' + ', '.join(ready) + '.'
        if failed: msg += ' last fails: ' + '; '.join(failed[:2])
        done(True, msg, status=s)
    done(True, 'installing now: ' + ', '.join(f"{k}: {WORDS.get(v['status'], v['status'])} ({v.get('progress', 0)}%)" for k, v in busy.items()), status=busy)

# install
try: fl = json.load(open(FLAG))
except Exception: fl = {}
if fl.get('active') or fl.get('connected'):
    done(False, "mama is using my desktop right now, so i won't install anything until she's done")
src = str(i.get('user') or i.get('source') or i.get('from') or '').lower()
if src in ('public', 'twitch', 'chat', 'viewer'):
    done(False, 'only mama can have me install apps')
a = apps()
alias = {'terminal': 'st', 'st terminal': 'st', 'system monitor': 'btop'}
m = re.search(r"\b(?:install|set ?up|download|get)\s+(?:me\s+|yourself\s+|the\s+|an?\s+)?(?:app\s+|program\s+)?([a-z0-9._ -]{1,30}?)(?:\s+(?:app|please|for me|on your desktop))?[.!?]*$", low)
want = (m.group(1).strip() if m else '')
name = want if want in a else alias.get(want) or next((k for k, v in a.items() if want and want in (v.get('title') or '').lower()), None)
if not name:
    done(False, f"'{want or text}' isn't on my app list yet. i can install: " + ', '.join(k for k, v in a.items() if v.get('enabled')))
if not a[name].get('enabled'):
    done(False, f"{a[name].get('title', name)} isn't ready to install yet: {a[name].get('disabled_reason', 'switched off')}")
cur = status().get(name, {})
if cur.get('status') in ('queued', 'building', 'downloading', 'installing'):
    done(True, f"already on it: {name} is {WORDS[cur['status']]} ({cur.get('progress', 0)}%)")
os.makedirs(os.path.join(HOME, 'jena-apps'), exist_ok=True)
log = open(os.path.join(HOME, 'jena-apps', 'installer.out'), 'a')
subprocess.Popen(['nice', '-n', '19', 'python3', INSTALLER, 'install', name], stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True, cwd=os.path.join(HOME, 'jena-apps'))
done(True, f"on it! asking GitHub to {'build' if a[name].get('mode') == 'build' else 'fetch'} {a[name].get('title', name)} for me. i'll show 'setting up…' until it's really installed", app=name)

#!/bin/bash
# Mirror Jena's activity memory to the site repo's `jena-memory` branch (never main), every 15 min.
# HELD while the repo is public: the anonymous fetch must FAIL (repo private) before anything is pushed.
# Pushes with Jena's existing deploy key (jenaci's), no force. Only her own activity memory + recent.md +
# notes/for_mama.md go up: no secrets (jena_memory redacts), no mama private chats (never written there).
set -u
cd /
REPO_HTTPS=https://github.com/pfn000/jena-magic-screen.git
REPO_SSH=git@github.com:pfn000/jena-magic-screen.git
MEM=/home/jena/.jena/memory
STAGE=/home/jenaci/memory-mirror
STATE=/home/user/tab/files/jena-memory/mirror-status.json
say() { printf '{"at":"%s","state":"%s","detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" > "$STATE"; echo "$1: $2"; }
if timeout 20 env GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false git ls-remote "$REPO_HTTPS" HEAD >/dev/null 2>&1; then
  say held "repo is still public (anonymous fetch works); memory stays box-local"; exit 0
fi
J="runuser -u jenaci --"
export GIT_SSH_COMMAND="ssh -i /home/jenaci/.ssh/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ ! -d "$STAGE/.git" ]; then
  $J git init -q "$STAGE" && $J git -C "$STAGE" remote add origin "$REPO_SSH"
  if $J env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git -C "$STAGE" fetch -q origin jena-memory 2>/dev/null; then
    $J git -C "$STAGE" checkout -q -B jena-memory origin/jena-memory
  else
    $J git -C "$STAGE" checkout -q --orphan jena-memory
  fi
fi
$J env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git -C "$STAGE" pull -q --rebase origin jena-memory 2>/dev/null || true
mkdir -p "$STAGE/memory"
python3 - "$MEM" "$STAGE/memory" <<'PY'
import json, re, sys, os
src, dst = sys.argv[1], sys.argv[2]
bad = re.compile(r'(pass(word)?|passwd|token|secret|api[_-]?key|cookie|otp|plexcode|mama000|BEGIN [A-Z ]*PRIVATE)', re.I)
out = []
for l in open(os.path.join(src, 'activity.jsonl'), encoding='utf-8', errors='replace'):
    if bad.search(l): continue
    out.append(l if l.endswith('\n') else l + '\n')
open(os.path.join(dst, 'activity.jsonl'), 'w').writelines(out[-20000:])
t = open(os.path.join(src, 'recent.md'), encoding='utf-8').read()
open(os.path.join(dst, 'recent.md'), 'w').write('\n'.join(x for x in t.split('\n') if not bad.search(x)))
fm = '/home/jena/notes/for_mama.md'
if os.path.exists(fm): open(os.path.join(dst, 'for_mama.md'), 'w').write(open(fm, encoding='utf-8').read())
PY
chown -R jenaci:jenaci "$STAGE"
$J git -C "$STAGE" add -A memory
if $J git -C "$STAGE" diff --cached --quiet; then say ok "nothing new"; exit 0; fi
$J git -C "$STAGE" -c user.name=Jena -c user.email=jena@users.noreply.github.com commit -q -m "Jena's memory $(date -u +%FT%TZ)"
if $J env GIT_SSH_COMMAND="$GIT_SSH_COMMAND" git -C "$STAGE" push -q origin jena-memory; then say pushed "$($J git -C "$STAGE" rev-parse --short HEAD)"; else say error "push failed"; fi

#!/usr/bin/env bash
# Vercel "ignoreCommand": exit 0 = SKIP this deploy, exit 1 = build it.
# Deploys are rate-limited, so commits that only touch box-side / CI / docs files don't spend one:
# box/, ops/, .github/, ANIMATIONS/, moves-pipeline/ and *.md never change the site.
# Compared against the last DEPLOYED commit (VERCEL_GIT_PREVIOUS_SHA), so a batch of pushes that touches the site
# anywhere still builds. Anything unknown (no previous sha, shallow clone without it, git error) builds.
base="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$base" ]; then echo "no previous deploy sha: build"; exit 1; fi
git cat-file -e "$base^{commit}" 2>/dev/null || git fetch -q --depth=50 origin "$base" 2>/dev/null || true
if ! git cat-file -e "$base^{commit}" 2>/dev/null; then echo "previous deploy $base not in clone: build"; exit 1; fi
changed=$(git diff --name-only "$base" HEAD -- . ':(exclude)box' ':(exclude)ops' ':(exclude).github' ':(exclude)ANIMATIONS' ':(exclude)moves-pipeline' ':(exclude)*.md') || { echo "git diff failed: build"; exit 1; }
if [ -z "$changed" ]; then echo "only box/ops/.github/ANIMATIONS/moves-pipeline/*.md changed since $base: skip deploy"; exit 0; fi
echo "site files changed since $base:"; echo "$changed" | head -20; exit 1

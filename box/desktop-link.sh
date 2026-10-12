#!/usr/bin/env bash
# Jena's machine side: bring up her virtual desktop, stream it view-only (x11vnc -> websockify/noVNC),
# open a public cloudflared quick tunnel, and announce the tunnel URL to the site so the
# "Virtual desktop" panel finds it automatically (tunnel URLs change on every restart).
#
#   JENA_SITE=https://your-site.vercel.app JENA_DM_KEY=yourpasscode ./box/desktop-link.sh
#
# Needs: Xvfb, openbox, x11vnc, websockify + novnc (apt install xvfb openbox x11vnc novnc websockify), cloudflared.
set -euo pipefail
DISP="${DISP:-:99}"; RES="${RES:-1280x800x24}"; PORT="${PORT:-6080}"; LOG="${LOG:-/tmp/jena-desktop}"
mkdir -p "$LOG"

if ! xdpyinfo -display "$DISP" >/dev/null 2>&1; then
  setsid nohup Xvfb "$DISP" -screen 0 "$RES" -nolisten tcp >"$LOG/xvfb.log" 2>&1 &
  for i in $(seq 50); do xdpyinfo -display "$DISP" >/dev/null 2>&1 && break; sleep 0.1; done
fi
pgrep -x openbox >/dev/null || (DISPLAY="$DISP" setsid nohup openbox >"$LOG/openbox.log" 2>&1 &)

# view-only: viewers can watch her desktop, never click or type on it
pgrep -f "x11vnc.*-rfbport 5900" >/dev/null || \
  setsid nohup x11vnc -display "$DISP" -forever -shared -viewonly -nopw -localhost -rfbport 5900 -noxdamage -quiet >"$LOG/x11vnc.log" 2>&1 &
sleep 1
pgrep -f "websockify.* $PORT " >/dev/null || \
  setsid nohup websockify --web /usr/share/novnc "$PORT" localhost:5900 >"$LOG/websockify.log" 2>&1 &
sleep 1

setsid nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" >"$LOG/cloudflared.log" 2>&1 &
URL=""
for i in $(seq 60); do URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/cloudflared.log" | head -1 || true); [ -n "$URL" ] && break; sleep 1; done
[ -z "$URL" ] && { echo "tunnel did not come up; see $LOG/cloudflared.log"; exit 1; }
WSS="wss://${URL#https://}/websockify"
echo "desktop stream: $WSS"
echo "page override:  ?desktop=$WSS"

if [ -n "${JENA_SITE:-}" ] && [ -n "${JENA_DM_KEY:-}" ]; then
  # re-announce every 5 minutes (the site's temporary store forgets on a cold start)
  ( while true; do
      curl -fsS -X POST "$JENA_SITE/api/desktop" -H "Content-Type: application/json" -H "X-Jena-Key: $JENA_DM_KEY" \
        -d "{\"url\":\"$WSS\"}" >/dev/null && echo "announced to $JENA_SITE" || echo "announce failed"
      sleep 300
    done ) &
fi
wait

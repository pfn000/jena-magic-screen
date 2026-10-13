#!/bin/bash
# Jena's stream compositor: her VTuber layout (/stream?layout=wide|phone) rendered in a real browser on its own
# X display (:98, never her desktop :99), captured with ffmpeg together with the page's audio (her voice + her
# soundboard), and sent to an RTMP ingest (YouTube / Twitch / TikTok) or a file.
#
#   jena-stream.sh wide  --rtmp rtmp://live.twitch.tv/app/<key>
#   jena-stream.sh phone --rtmp rtmps://<tiktok ingest>/<key>        (TikTok: 9:16)
#   jena-stream.sh wide  --out /tmp/test.mp4 --seconds 8             (a test file, nothing goes live)
#
# Options: --url BASE (default https://jena-magic-screen.vercel.app), --size WxH (default 1280x720 / 720x1280: 720p fits her box's memory; 1920x1080 works when memory allows),
#          --scale N (device pixel ratio, default 1), --no-phone-switch.
# Privacy: the page is the OBS page (?obs=1 is forced by the page itself): censored desktop frames only, no private
# controls, never mama's raw view. The page fails closed (desktop "asleep") if the censor or her box can't answer.
# Phone layout: her desktop :99 is put into N•OS phone mode (portrait) while streaming, and put back afterwards, but
# NEVER while mama has the desktop (/home/jena/.jena/mama_takeover.json active/connected) -> refuses instead.
# Stream keys are read from the command line or env JENA_RTMP; they are never written to disk or logs by this script.
set -u
# if memory runs out, the kernel takes this stream down first, never her own desktop apps
echo 1000 > /proc/$$/oom_score_adj 2>/dev/null
LAYOUT="${1:-wide}"; shift || true
URL="https://jena-magic-screen.vercel.app"; OUT=""; RTMP="${JENA_RTMP:-}"; SECS=""; SIZE=""; SCALE=1; SWITCH=1
while [ $# -gt 0 ]; do case "$1" in
  --url) URL="$2"; shift 2 ;; --out) OUT="$2"; shift 2 ;; --rtmp) RTMP="$2"; shift 2 ;;
  --seconds) SECS="$2"; shift 2 ;; --size) SIZE="$2"; shift 2 ;; --scale) SCALE="$2"; shift 2 ;;
  --no-phone-switch) SWITCH=0; shift ;; *) echo "unknown option $1" >&2; exit 1 ;; esac; done
case "$LAYOUT" in wide) DEF=1280x720 ;; phone|tiktok) LAYOUT=phone; DEF=720x1280 ;; *) echo "layout: wide|phone" >&2; exit 1 ;; esac
SIZE="${SIZE:-$DEF}"; W="${SIZE%x*}"; H="${SIZE#*x}"
WW=$(( W / SCALE )); WH=$(( H / SCALE ))   # the browser window is in CSS pixels; the display is in real pixels
[ -n "$OUT$RTMP" ] || { echo "need --rtmp URL (or JENA_RTMP) or --out FILE" >&2; exit 1; }
DISP="${JENA_STREAM_DISPLAY:-:98}"; RUN=/tmp/jena-stream; mkdir -p "$RUN"
CHROME="${JENA_STREAM_CHROME:-$(ls -d /home/user/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)}"
FLAG=/home/jena/.jena/mama_takeover.json
takeover() { sudo -n cat "$FLAG" 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(1 if d.get("active") or d.get("connected") else 0)' 2>/dev/null || echo 0; }
PIDS=(); SWITCHED=0
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; sleep 0.5
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  if [ "$SWITCHED" = 1 ] && [ "$(takeover)" = 0 ]; then
    DISPLAY=:99 xrandr --fb 1600x704 >/dev/null 2>&1; DISPLAY=:99 xrandr --output screen --mode 1600x704 >/dev/null 2>&1
    sudo -n /home/jena/jenaos/mode.sh desktop >/dev/null 2>&1 || /home/jena/jenaos/mode.sh desktop >/dev/null 2>&1
  fi
  rm -rf "$RUN/profile" "$RUN/pulse"
}
trap cleanup EXIT INT TERM

# phone layout: N•OS phone mode behind her (portrait 396x704 = 9:16 at her 704-px height)
if [ "$LAYOUT" = phone ] && [ "$SWITCH" = 1 ]; then
  if [ "$(takeover)" = 1 ]; then echo "mama has the desktop right now: not switching it to phone mode (try again after she's done)" >&2; exit 3; fi
  CUR=$(DISPLAY=:99 xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2}')
  if [ "${CUR%x*}" -ge "${CUR#*x}" ] 2>/dev/null; then
    DISPLAY=:99 xrandr --output screen --off >/dev/null 2>&1; DISPLAY=:99 xrandr --fb 396x704 >/dev/null 2>&1
    sudo -n /home/jena/jenaos/mode.sh phone >/dev/null 2>&1 || /home/jena/jenaos/mode.sh phone >/dev/null 2>&1
    SWITCHED=1
  fi
fi

nice -n 10 Xvfb "$DISP" -screen 0 "${W}x${H}x24" -nolisten tcp -noreset >/dev/null 2>&1 & PIDS+=($!)
mkdir -p "$RUN/pulse"; export PULSE_RUNTIME_PATH="$RUN/pulse" PULSE_SERVER="unix:$RUN/pulse/native"
pulseaudio -n --daemonize=no --exit-idle-time=-1 --disable-shm=yes \
  --load="module-native-protocol-unix socket=$RUN/pulse/native auth-anonymous=1" \
  --load="module-null-sink sink_name=jena_stream rate=44100" --load="module-always-sink" >/dev/null 2>&1 & PIDS+=($!)
sleep 1.5; export PULSE_SINK=jena_stream
# her soundboard tool (box/stream/jena-sfx.py, run as her own user) plays into this sink: let her reach the socket
chmod 755 "$RUN" "$RUN/pulse" 2>/dev/null
# a steady stream of silence keeps the capture clock running between sounds (an idle sink stalls the recorder)
pacat --playback -d jena_stream --rate=44100 --channels=2 --format=s16le --latency-msec=200 /dev/zero >/dev/null 2>&1 & PIDS+=($!)
DISPLAY="$DISP" nice -n 10 "$CHROME" --kiosk --no-first-run --no-default-browser-check --disable-infobars \
  ${JENA_STREAM_CDP:+--remote-debugging-port=$JENA_STREAM_CDP} --user-data-dir="$RUN/profile" --window-position=0,0 --window-size="$WW,$WH" --force-device-scale-factor="$SCALE" \
  --autoplay-policy=no-user-gesture-required --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
  --no-sandbox --disable-dev-shm-usage --renderer-process-limit=2 --js-flags=--max-old-space-size=384 \
  --user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156 Safari/537.36 · stream" \
  "$URL/stream?layout=$LAYOUT" >/dev/null 2>&1 & PIDS+=($!)
echo "waiting for the page to load (Jena's body + her desktop)…" >&2
sleep "${JENA_STREAM_WARMUP:-20}"
DUR=(); [ -n "$SECS" ] && DUR=(-t "$SECS")
if [ -n "$RTMP" ]; then DEST=(-f flv "$RTMP"); else DEST=(-movflags +faststart "$OUT"); fi
FPS="${JENA_STREAM_FPS:-30}"; PRESET="${JENA_STREAM_PRESET:-veryfast}"
nice -n 5 ffmpeg -hide_banner -loglevel warning -y \
  -thread_queue_size 4096 "${DUR[@]}" -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${W}x${H}" -i "$DISP" \
  -thread_queue_size 4096 "${DUR[@]}" -f pulse -fragment_size 4096 -i jena_stream.monitor \
  -af aresample=async=1000 -c:v libx264 -preset "$PRESET" -tune zerolatency -b:v 4500k -maxrate 4500k -bufsize 9000k \
  -g $((FPS * 2)) -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 "${DEST[@]}"

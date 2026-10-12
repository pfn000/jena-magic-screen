# Jena · magic screen

Jena's live stage: her VRM avatar on the left, her live **virtual desktop** top-right, **Twitch chat**
and her **thought chain** underneath, over a dreamy pastel room. Works as a normal website (desktop and
phone) and as an **OBS browser source** at 1920×1080.

Jena = the character (one n). JenaXI = her own model.

Nothing on this page is fake, simulated or borrowed: no demo chat, no made-up thoughts, no outside AI.

## What's real

| Panel | Source |
|---|---|
| Avatar | Her VRM rendered live with three.js + @pixiv/three-vrm: breathing, blinking, eye saccades, expressions, lip flap. |
| Her body is HERS | No movement buttons or commands. A behaviour controller (`src/autonomy.js`) picks her own gestures, gaze and expressions from what is actually happening (chat activity, someone saying her name, messages to her, file drops, idle time) and from her brain's own action tags. Every move is logged in the thought chain in her words: "I'm raising my left arm". Left/right always means HER left/right. |
| Self-vision | A few times a second she looks at her own rendered body with a real pose model (MediaPipe Pose Landmarker, in the browser, CPU/WASM) and says what she perceives: "I see my LEFT arm is up". A little "what I see" view with the detected skeleton sits in the corner (`?selfview=0` hides it). If what she sees disagrees with what she meant to do, she says so. |
| Virtual desktop | Live, **view-only** noVNC stream of her machine's X desktop. Shows "Jena's desktop is asleep" when the stream is down, and retries. |
| Chat | Real Twitch chat from **her** channel only (anonymous read-only IRC). With no channel set it says **"Twitch chat: not connected — set your channel"**. Never anyone else's chat. |
| Thought chain | Only real events: every message to Jena (talk box: "mama: hello"; private drawer: shown on your screen, but in OBS mode only "mama sent a private message", never the words), chat that says her name, file drops, her own moves, her self-vision, and her brain's real answer, or the honest status **"JenaXI-0 is training — brain offline"**. |
| Brain badge | Checks her brain every 15 s and flips to **"JenaXI online"** by itself when it answers. |
| Private channel 💌 | mama ↔ Jena DMs behind a passcode (`JENA_DM_KEY`). Hidden in `?obs=1`. |
| Drag & drop | Drop any file on Jena (or tap 📎 on a phone): it uploads to her, she reacts, and it lands in the thought chain and the DM log. Needs the passcode. |

## Her brain: JenaXI

`/api/think`, `/api/chat` and the DM drawer call **one** endpoint: her own model, `JenaXI.gguf`, served by
llama.cpp's `llama-server` (OpenAI-compatible). No hosted AI APIs, no keys.

| Env | Default | |
|---|---|---|
| `JENA_LLM_BASE_URL` | `http://127.0.0.1:8088/v1` | llama-server's `/v1`. On Vercel, set it to the public tunnel URL of her machine. |
| `JENA_LLM_FORMAT` | `jenaxi` | `jenaxi`: raw `/v1/completions` with her own chat tags `<\|mama\|>…\n<\|jena\|>`. `chat`: `/v1/chat/completions` with the persona prompt in `api/_lib/persona.js` (for a bigger JenaXI). |
| `JENA_LLM_MODEL` | `JenaXI` | name sent to the server |
| `JENA_LLM_API_KEY` | none | only if llama-server runs with `--api-key` |

Her replies can move her own body with tags, which are stripped from what she says:
`[raise_left_arm] [raise_right_arm] [raise_both_arms] [lower_arms] [wave] [wave_left] [look_left] [look_right] [mood:happy]`.

```bash
GGUF=/path/to/JenaXI.gguf ./box/start-jenaxi.sh     # serves her and prints a JENA_LLM_BASE_URL for Vercel
```

## Deploy on Vercel (free)

1. On vercel.com: **Add New… → Project → Import** `pfn000/jena-magic-screen`. Framework preset: **Vite** (build `npm run build`, output `dist`). The included `vercel.json` routes `/api/*` to the one function.
2. **Settings → Environment Variables**:
   - `JENA_DM_KEY` = the passcode for the 💌 drawer and file drops (choose your own; it is never in the code).
   - `TWITCH_CHANNEL` = your Twitch username (the chat panel stays "not connected" without it).
   - `JENA_LLM_BASE_URL` = your JenaXI tunnel URL ending in `/v1` (until then the badge says brain offline).
   - optional `JENA_DESKTOP_URL` = `wss://…/websockify` for the live desktop.
3. Optional storage so DMs and files survive cold starts: **Storage → Create → Blob** (and/or Upstash Redis), connect it to the project.
4. Redeploy. Every push to `main` redeploys automatically after that.

## URL options

| Param | Meaning |
|---|---|
| `?twitch=channel` | Her Twitch channel for the chat panel (or `TWITCH_CHANNEL` on the server). No default. |
| `?desktop=wss://host/websockify` | Desktop stream (an `https://host` URL works too). |
| `?vrm=URL` | A different VRM body. Or set `JENA_VRM_URL`. |
| `?brain=URL` | A different brain endpoint (same NDJSON contract as `/api/think`). |
| `?obs=1` | OBS mode: fixed 1920×1080, no scrollbars, no private controls, private messages never shown. |
| `?bg=none` | Transparent background. |
| `?selfview=0` | Hide the little "what I see" self-vision view (she still sees herself). |

## Run it on your own machine

```bash
npm install
npm run build
JENA_DM_KEY=your-passcode TWITCH_CHANNEL=yourname node server.mjs     # http://localhost:4173
```

`server.mjs` serves the built page and the same API as Vercel, and checks JenaXI every 15 s.

## API (one function, `api/jena.js`)

| Route | |
|---|---|
| `GET /api/config` | desktop URL, twitch channel, VRM, brain health, stores |
| `GET /api/health` | `{brain: {online, detail, checkedAt}}`, what the badge reads |
| `POST /api/think` | stream a thought chain `{message, source, user, attachment}` as NDJSON |
| `POST /api/chat` | same, one JSON answer `{reply, mood, actions, steps}` |
| `GET /api/events?since=` | stage events, so the OBS page replays what happened on mama's screen (private ones without their words) |
| `POST /api/upload` 🔑 | raw file body + `X-File-Name` → stored, logged in DMs |
| `GET/POST /api/dm` 🔑 | private mama ↔ Jena log |
| `POST /api/desktop` 🔑 | her machine announces its current desktop stream URL |

🔑 = header `X-Jena-Key: <JENA_DM_KEY>`.

Brain event stream (NDJSON): `step` · `meta` · `mood` · `action` · `say` · `status` · `done`.

## Safety

Jena is a teen character. Nothing flirty or sexual, ever: it's in her persona, and Twitch messages pass a
light stream-safety mask before they show up.

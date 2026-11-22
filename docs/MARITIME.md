# TowerAI on Maritime

[Maritime](https://maritime.sh) (YC F26) is a managed cloud for AI agents: each agent gets its own always-on
machine with a public HTTPS address, and an idle one sleeps and wakes on the first request in about a second.
TowerAI runs there as one agent: the live Pearson demo, its web app, and the tower agent you can chat with.

## What runs

- **The demo.** The [`Dockerfile`](../Dockerfile) builds the web app and starts the judge demo: rules
  controller, simulated radio, recorded voice. `ELEVENLABS_API_KEY` is empty, so it never spends credits.
- **The tower agent's chat.** Maritime's agent contract is `POST /chat` with `{"message": "..."}`, answered with
  `{"response": "..."}`. TowerAI answers from the same rule-built briefing as the handoff card and its
  **Ask the agent** tab: about the flight you name, or the flight that most needs a person, or the airport.
  It only reads; it never sends anything to a plane.
- **Health.** `GET /health` returns 200 with the run's status.

## Deploy (about 5 minutes, needs your account)

```bash
npm install -g maritime-cli
```

```bash
maritime onboard --json
```

Sign in, verify your email (deploys are refused until it is verified), and add a card for the 7-day trial
(nothing is charged if cancelled within the week). Then, from anywhere:

```bash
maritime create towerai --repo https://github.com/michaelmazilu/tower --public --wait
```

Add `-b <branch>` to deploy a branch other than `main`. The build takes 1 to 3 minutes. The **URL** on the
agent's page is the live demo, in the form `https://<agent-id>.mtm.sh/`. Open it and click **2 operations**.

Ask the tower agent from the terminal:

```bash
maritime chat towerai "what needs me?"
```

```bash
maritime chat towerai "why is DLH471 red?"
```

The same chat works from the agent's page in the Maritime dashboard. Redeploy after a push with
`maritime deploy towerai --wait`; build logs are in `maritime history towerai --json`.

## How it fits Maritime's rules

| Maritime asks | TowerAI |
|---|---|
| Dockerfile at the repo root | [`Dockerfile`](../Dockerfile), `node:22-slim` with CA certificates |
| Listen on `0.0.0.0:$PORT`, never a fixed port | `HOST=0.0.0.0` in the image; `PORT` is read from the environment |
| `GET /health` returns 2xx, fast, no side effects | Existing health route |
| `POST /chat` replies within 30 s | Answers by rules in well under a millisecond |
| Exec-form `CMD`, not a shell string | `CMD ["npx", "tsx", "packages/server/src/index.ts"]` |
| Keep state under `/data` | The demo keeps none: `TOWERAI_DATA_DIR=off` |

## Things to know

- **Anyone with a public URL can drive the demo** (restart, take over, hand back). It is a simulation with no
  key, so nothing is spent. Remove `--public` to keep it behind a Maritime share link instead.
- **Never add `ELEVENLABS_API_KEY` to a public agent.** `.env` is git-ignored and in `.dockerignore`, so it
  is never in the image.
- **First visit after a sleep** waits about a second while the machine wakes.
- **Verified live on Maritime** (22 Nov 2026, agent `towerai`, built from `feat/ask-the-agent-assistant-ui`):
  the build took about 3 minutes; on the public `https://<agent-id>.mtm.sh/` URL, `/health` returned 200, the
  page and its web bundle loaded, the operations screen showed "tower link: live" with the sim clock moving
  (so the WebSocket works), **restart** worked, the **Ask the agent** tab answered "Why?" for DLH471, and
  `maritime chat towerai "what needs me?"` returned the tower agent's answer. `maritime agents get` needs the
  agent's id, not its name; `maritime chat` accepts either.

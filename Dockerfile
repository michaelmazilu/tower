# TowerAI on Maritime (https://maritime.sh): the offline judge demo as a public, always-on agent.
# Maritime builds this from the repo root, sets PORT, forwards public HTTPS to it, and wakes the
# machine on the first request. It also calls POST /chat (the tower agent) and GET /health.
FROM node:22-slim

# Slim images lack CA certificates; Maritime's custom-container guide asks for them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

# The judge demo: rules controller, simulated radio, recorded voice. No key, so it never spends.
# HOST=0.0.0.0 because the public address is not loopback; PORT comes from Maritime.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ELEVENLABS_API_KEY= \
    TOWERAI_CONTROLLER=baseline \
    TOWERAI_AI_PILOTS=off \
    TOWERAI_SCENARIO=judge-demo \
    TOWERAI_DATA_DIR=off \
    TOWERAI_RADIO_CONTROLLER=simulated \
    TOWERAI_RADIO_PILOTS=simulated

# Exec form: Maritime's guide warns that a shell-string CMD breaks.
CMD ["npx", "tsx", "packages/server/src/index.ts"]

import { agentPlugins } from "./agents";

/** Cached voice is free and works offline. AI pilots spend, so only `npm run judge:live` switches them on. */
export const plugins = agentPlugins({ pilots: { enabled: process.env.TOWERAI_AI_PILOTS === "on", maxCalls: 6 } });

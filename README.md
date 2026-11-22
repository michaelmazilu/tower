# TowerAI

**We are going to help solve the global air traffic control crisis.**

[5.1 billion passengers](https://www.iata.org/en/pressroom/2026-releases/06-07-middle-east-disruptions-high-fuel-prices-halve-airline-industry-profitability/) will trust their lives to air traffic control this year, yet the world needs [71,000 new controllers by 2034](https://aviationnews.eu/?p=129204), and each takes years to train. In March, two pilots died in a runway collision at LaGuardia while an [overnight tower crew of two covered the work of several](https://npr.org/2026/03/24/nx-s1-5759710/laguardia-airport-plane-crash). On November 13, a single system failure [stopped every departure in America](https://www.faa.gov/newsroom/faa-statement-nationwide-ground-stop). The world is asking too few people to keep too many lives safe. We need a better way to protect the people in the sky, and the people guiding them home.

Using ElevenLabs, we built the coworker every controller deserves: one that works the radio beside them, speaks to pilots in real aviation language, and never gets tired.

TowerAI watches every aircraft in a live simulation of Toronto Pearson to spot danger as it develops. It then handles routine clearances, checks each against safety rules before it is spoken, sends aircraft around blocked runways, alerts emergency crews, explains every decision, and immediately calls the controller when human judgment matters, so they can take over with one click and focus on saving lives.

**No controller should ever have to carry the sky alone. With TowerAI, they won't.**

*This is a simulation, not a system for real traffic. Anyone can sit in the pilot's seat and talk to the tower: ElevenLabs hears and speaks, rules and an agent understand, and the validator decides. Pearson operations run a rules controller so they are reliable, and every model decision is labelled `llm`. [What is real and what is modelled](docs/DEMO.md#real-and-modelled).*

## Run it

```bash
npm install
npm run judge
```

Open http://127.0.0.1:8787. To run it as a public, always-on agent on [Maritime](https://maritime.sh), see [docs/MARITIME.md](docs/MARITIME.md). No key, no network, no credits. The click-by-click script, what is real and what is modelled, and recovery steps are in [docs/DEMO.md](docs/DEMO.md).

- **Operations:** live Toronto Pearson. Map, a box per flight ranked by risk, replay of any flight, decisions with reasons and latency, and operator takeover and handback with a plain card when a flight needs a person: what is wrong, where it is, time to decide, what to do in one press, and what the agent will do on hand back ([why](docs/DEMO.md#the-handoff)).
- **World:** a recorded 40-minute simulation of 59 controlled flights at 11 airports and 1,000 background flights, with every conversation, separation, risk and response time at any point of playback.

| Command | |
|---|---|
| `npm run judge` | Build and serve the demo: rules controller, cached voice |
| `npm run judge:talk` | The full demo: talk to the tower from the cockpit and hear any world flight. Reads `.env` and spends ElevenLabs credits |
| `npm run judge:live` | The one switch for live LLM tower and pilots. Reads `.env` and spends ElevenLabs credits |
| `npm run record:world` | Rebuild the world recording offline from recorded LLM choices and audio |
| `npm run dev` | Server with reload; the UI dev server is `npm run dev -w @towerai/web` |
| `npm run demo` | The guided scenario headless |
| `npm test`, `npm run typecheck` | Checks |

Only `judge:talk` and `judge:live` load `.env`. Other settings are environment variables, listed in [.env.example](.env.example).

## The airport

The default airport is the real Pearson layout, built from OpenStreetMap:

- all five runways at their mapped lengths and true bearings;
- the full taxiway network with its real names (about 75 km, 94 named taxiways);
- 79 gates at Terminal 1 and Terminal 3. Terminal 3 gates carry their gate names (`B11`, `C36`); Terminal 1 gates carry stand numbers (`131`, `164`), as mapped. Cargo, FedEx, infield and de-icing areas are drawn but nothing parks there.

Two things OpenStreetMap does not have are derived when the airport is built ([osm.ts](packages/core/src/airport/osm.ts)):

- **Hold lines.** Every taxiway that meets a runway gets a hold-short point 90 m from the centreline, joined to the runway by one straight link. These are placed by rule, not surveyed.
- **Stand connections.** Each stand is joined to the nearest taxilane by a straight pushback line. Stands that overlap another, or whose pushback line would sweep through a neighbour, are left out.

The map data is checked in ([cyyzOsm.ts](packages/core/src/airport/data/cyyzOsm.ts)); nothing is fetched at runtime. To refresh it:

```bash
npm run import:airport
```

Point ids such as `A.15` or `HS_Q_0523` are generated from that data and change if it is re-imported. Gate names, taxiway names and runway designators do not; prefer those in anything hand-written.

`GET /api/airport` returns the graph plus a `drawing` block (runway rectangles, every taxiway centreline, apron outlines, stand lines) and an `attribution` string that must be shown wherever the map is displayed. Coordinates are metres east and north of `reference`.

A small hand-authored schematic airport is kept for fast tests: scenarios `guided-demo-schematic` and `sandbox-schematic`.

## Layout

```
packages/contracts  The types shared by everything below
packages/core       The Pearson simulation: movement, runways, clearances, radio, validated tool gateway
packages/world      The worldwide simulation and recorder (see NOTICE)
packages/server     HTTP and WebSocket host
  ops/              The operator's view: risk, alerts, history, takeover, and the demo's director
  atc/              The hosted tower
  agents/, voice/   ElevenLabs agents, spend guard, recorded choices, cached voice
packages/web        The operations and world screens
tools/osm           One-off import of airport geometry
```

## How control flows

```
pilot request ──▶ radio queue ──▶ controller hears it (event, attention: true)
                                        │
                     controller calls issue_clearance (tool gateway)
                                        │
                      simulation validates ──▶ rejected: reason returned, nothing changes
                                        │ accepted: recorded, runway reserved
                                        ▼
                     tower transmission on the radio queue
                                        │ completes (or fails: clearance expires)
                                        ▼
                     pilot readback, matched against the clearance
                                        │ correct
                                        ▼
                     aircraft acts; every state change logs its cause
```

A tool call, a transmission and a readback are three separate steps. Aircraft act on an ordinary clearance after its transmission and a valid readback. Failed transmissions expire their clearance immediately and release any unused reservation it owns. A change of runway is such a clearance too: when a runway closes, permissions are withdrawn at once and the runway and route change only on the readback, and a flight a person holds is left to that person. Stop instructions (`GO_AROUND`, `HOLD_POSITION`, `HOLD_SHORT`) take effect on transmission and stay in force if the readback is missing. `HOLD_POSITION` also withdraws a takeoff clearance, so the aircraft needs a new one to roll. Cancelling an active taxi clearance stops the aircraft at its current position or after it finishes crossing an occupied runway. It needs a new taxi clearance to continue.

The controller chooses among valid actions; it cannot override the rules. There is no tool that sets a position, phase or speed: the heading, altitude and speed of a missed-approach vector or an emergency return are worked out by the rulebook.

## What the simulation enforces

- A physical runway belongs to one aircraft at a time (occupancy from real positions, plus a reservation made when a clearance is accepted).
- No takeoff, line-up or crossing in front of an arrival that is too close; a wider gap for an urgent or emergency arrival.
- An emergency is number one: routine traffic is not cleared to land ahead of it on its runway unless it will be well clear.
- Minimum time between departures from the same runway.
- Runways that physically cross (05/23 with 15L/33R and 15R/33L) are used one at a time: a takeoff or landing on one is refused while the other has a takeoff or landing in progress, cleared, or an arrival close in. Taxiing across a crossing runway elsewhere does not count.
- No two aircraft are ever cleared head-on along the same taxiway. A taxi route that runs against another aircraft's cleared route, or through an aircraft parked on a taxiway waiting for its own clearance, is refused (`TAXI_ROUTE_CONFLICT`) until the other has gone by; the router looks for a way round first.
- Pushback is refused (`APRON_BLOCKED`) while another aircraft is pushing onto the same piece of apron, is about to pass behind the gate, or is about to park on the neighbouring stand.
- Aircraft stop at hold lines they are not cleared past, at their clearance limit, behind traffic, and for oncoming traffic in a shared taxiway stretch.
- An arrival with no landing clearance, or a blocked runway, goes around by itself at 1 NM.
- A departure that turns back with an engine failure may land on the runway it departed from, even if that runway is departures-only.
- A malformed or unknown command is refused and changes nothing.
- Phase changes outside the state machine throw.

Thresholds are in `DEFAULT_RULES` in [types.ts](packages/core/src/types.ts).

## Server

The app's routes are documented at the end of [contracts](packages/contracts/src/index.ts), the simulation and tool routes at the top of [server/src/index.ts](packages/server/src/index.ts). `GET /health` is the health check and `/viewer` is a developer's view of the simulation (its 3D mode fetches Esri imagery; the demo never uses it).

The server binds to 127.0.0.1 and refuses foreign hosts and origins. Set `TOWERAI_CORS_ORIGIN` for another origin, and `TOWERAI_SECRET` and `HOST` before exposing it. The bundled web app does not send the secret: set it only for API or webhook use, and leave it empty for the demo.

## Agents

`judge:talk` and `judge:live` need a key and, once per account, agents. Copy the example file and put `ELEVENLABS_API_KEY` in it:

```bash
cp .env.example .env
```

The tower, controller, pilot and cockpit agents and their tools are created by an idempotent script, which spends no credits. Run it again after changing a prompt:

```bash
node --env-file=.env --import tsx packages/server/src/agents/setup.ts
```

Lines voiced while the app runs are kept in `packages/server/data/audio/live/`, which git ignores.

Agents never write safety-critical words: they call validated tools or pick from validated options, and any failure falls back to rules. Spending is capped in code at 9,500 credits (lower it in the shell, for example `TOWERAI_CREDIT_CAP=500 npm run judge:talk`). How latency was measured, with its flaws, is in [docs/latency-results.md](docs/latency-results.md).

## Replay

Every outside influence is a command logged with the tick it arrived on. Scenario + seed + commands reproduce a run exactly, with no controller or LLM involved. `npm start` and `npm run dev` record runs to `packages/server/data/runs/<runId>/` as `meta.json`, `events.jsonl` and `commands.jsonl`.

## Honest limits

- The airport is real geometry, not a certified chart. Hold lines and stand connections are derived by rule; taxiways are single lines, so two aircraft cannot pass on one; runway headings are true, not magnetic. Not for navigation.
- The Terminal 3 building outline is missing from the drawing data (its stands and taxilanes are present).
- Pearson flight is 2D kinematics with altitude. There is no wind, no wake modelling beyond a fixed departure interval, and headings, altitudes and speeds only for missed approaches and emergency returns: other airborne conflicts are shown and alerted, not vectored. General vectoring is in the world simulation.
- All traffic, weather and emergency responders are simulated. Supervisor lines in the world recording are scripted stand-ins.
- The stand-in controller is first come first served and does not plan. Under heavy arrival streams it causes avoidable go-arounds and long waits. That is the gap the AI controller is meant to fill; its decision quality has not been measured.
- Head-on taxi conflicts are prevented at clearance time rather than untangled afterwards, which costs some waiting at the gate or runway exit in busy periods. The test suite runs 12 aircraft for 40 minutes on one seed on the real layout with no standoff; a ring of aircraft each following the next is not formally ruled out, and `get_conflicts` would report it.

## Credits

- Airport map data © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright).
- World coastlines: Natural Earth (public domain), through world-atlas.
- Conflict detection and geodesy ported from BlueSky (MIT), trajectory code from OpenAP (LGPL-3.0). See [packages/world/NOTICE](packages/world/NOTICE).
- Voice and agents: [ElevenLabs](https://elevenlabs.io). The cached lines were made on the free plan, which requires this credit and is non-commercial.
- `/viewer` 3D imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community.

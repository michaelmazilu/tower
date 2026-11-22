# The TowerAI demo

## Start

```bash
npm run judge:talk
```

Open **http://127.0.0.1:8787** in a full window, 1280x720 or larger. This is the full demo: a visitor talks to the tower and any world flight can be heard. It needs `ELEVENLABS_API_KEY` in `.env` and a network, and spends credits (up to about 150 for a new spoken exchange, up to 66 for a repeated one (transcription), typically about 35 and at most 84 for each new world line), stopping at 9,500.

`npm run judge` is the fallback: no key, no network, no credits. The cockpit then takes typed input, and lines without a recording use the browser's voice.

Before judges arrive: press **restart** (bottom right), then **sound** so it reads `on`, and turn the Mac's volume up. The choice is remembered; after a reload the key reads `press` until the page is clicked once. Lines marked `recorded voice` are ElevenLabs. Lines marked `browser voice` are read by a voice installed on this computer, offline.

## Four minutes

The pitch in one line: *TowerAI is the coworker every air traffic controller needs: it works the radio beside them, checks every clearance before it is spoken, shows its work, and calls them when judgment matters.*

### Act 1: let someone new fly (about 1:30)

Press **1 cockpit**, then **reset** (bottom right). Press space once beforehand so the browser already has the microphone. Hand over the laptop and say: "You're the pilot. Hold space and talk. The tower will get you flying."

| They do | What happens | Say |
|---|---|---|
| "Oh no, we're crashing!" | The tower lists the claim against the aircraft's data: on the ground, zero knots, engines normal, "you haven't taken off". It does not declare a false emergency, and it offers help. | "It didn't just hear the words. It checked the aircraft." |
| "Everything is fine." | The report is withdrawn. | |
| "I want to take off, what do I need?" | The validator clears the runway and the tower says exactly what to read back. | "They've never done this. Their coworker is walking them through it." |
| Read the big line back | The plane rolls and lifts off about 25 seconds later. A wrong runway is refused. | "Nothing moves until the readback is right. Look at the time to answer." |
| Once airborne, you press **engine failure**; they say "Mayday, our engine failed!" | Now the data confirms it: mayday, a turn home, responders. They read it back. | "Same words, different data, different decision." |
| Optional, about a minute later | The tower calls them to land. | Otherwise press **2 operations** here. |

If the room is loud, type in the box: everything else works the same. Ask the visitor first: their voice goes to ElevenLabs to be transcribed.

### Act 2, optional: let them supervise

Hand the laptop to someone outside the team, press **restart**, and say only: "You just became an air traffic controller. Your coworker will call you when it needs you." At about 0:30 DLH471 calls for a person. Let them read the card, press **Take over and send both**, then **Hand back to agent**. They should not need you to explain anything: that is the point.

### Act 2: Pearson operations (about 1:00, stop at the mayday)

The **skip to** key (bottom right) always names the next scripted beat and runs the simulation ahead to it.

| Sim clock | Do | Say |
|---|---|---|
| 0:00 | Press **restart**. Let it talk. | "This is your coworker's first shift at Toronto Pearson. Map on the left, every flight on the right, sorted by who needs you. You are hearing it work the radio with the pilots." |
| 0:14 | Two boxes turn red. | "A departure rolled onto the runway in front of an arrival. Within seconds the arrival is sent around and the intruder is stopped. Nobody asked it to." |
| 0:26 | Click the red **DLH471** box. | "It knows when to ask for help, and it doesn't dump the problem on you. Like one controller briefing another: what's wrong, where the plane is, five minutes to decide, and what to do." |
| 0:35 | **Take over and send both**. | "One press: I have the aircraft, the agent is locked out, and its two calls go out in my name, after the validator. It sends exactly what I saw; if the picture had changed it would refuse and ask me to look again." Point at the focus line: "Routine alerts wait until I'm done. Emergencies still come through." |
| 0:45 | Read the line beside **Hand back to agent**, then press it. Drag the scrubber back, then **go live**. | "Before I let go, it tells me what it will do, and what it won't. Then it confirms it has the aircraft, and any moment can be replayed." |
| 0:58 | **all flights**. | "Weather goes to everyone." The go-around also gets a heading, altitude and speed, read back. |
| 1:18 | Press **skip to mayday** if needed. Click **UAL119**. | "Engine failure. Roger mayday, a heading, an altitude, number one, then fire and rescue, who answer. Responders are the squares by the runway." |
| 1:50 | Press **skip to closure** if needed. | "A runway closes. Permissions go at once, but nobody changes runway until the new one has been read back." |
| 5:00 | Press **skip to landing** (it jumps to 4:52). | "Landed safely, with the routine traffic kept behind it." The outcome shows in the banner. |

### Act 3: the world (about 1:00)

Turn **sound** on. Click any aircraft and its conversation plays in recorded ElevenLabs voice, offline and at 0 credits. `QTR721`, `ACA860` and `DAL401` open on their storyline moments; every other flight opens on what it is saying at the playhead.

| Do | Say |
|---|---|
| Click **3 world**. | "The same coworker, hired worldwide, shown as a recorded simulation: 59 controlled flights at 11 airports among 1,000 background flights, from gate to en-route, handed between ground, tower, departure, centre and approach." |
| Point at the top row, then click **attention**. | "Conflicts predicted and resolved, zero losses of separation, and exactly which flights need a person." Press a count on the map to open that region; Escape steps back. |
| Click **all**, type `DAL401`, click it. It opens on the mayday and speaks. | "Engine failure. The controller picks the return from validated options, the pilot reads back, responders are alerted, and the arrivals ahead are moved out so it is number one. Response is call to on air." |
| **all flights**, then open `KLM643` and drag to its start. | "These two lines are a real ElevenLabs agent controller and a real agent pilot: stop climb at FL300 because of traffic at FL310, its reason, and the measured thinking time of each." |
| **all flights**, then open `ACA860`. | "Two aircraft converging at the same level. The controller, rules on this line, chose a heading: this is its reason, what it looked at, and the separation line staying above the minimum. Clear of traffic comes only after the closest point, with the true miss distance." |
| **all flights**, then open `QTR721`. Drag its track to about 6 minutes. | "When a decision is above its authority it escalates. A supervisor, scripted here, takes over, decides and hands back." |
| Any arrival at about 34 miles, for example `JBU616` at 13:05. | "Sequencing: a validated speed, read back, and the track slows." |
| **all flights**, **60x**, let it run. | "Every conversation, every decision, replayable at any second." |

More moments, by clicking the timeline or searching: `JBU523` (weather deviation blocked by traffic, 13:11), `UAL408` (altitude refused), `AFR083` (hydraulic failure, human takeover, 13:15), `ANA861` (depressurisation, 13:28), `TAM8084` (a request for a human left open).

## The handoff

Handing a live situation from automation to a person is where automation tends to fail people. The person was out of the loop, has to rebuild the picture under time pressure, and does not know what the machine was about to do (Bainbridge, *Ironies of Automation*, 1983). Air traffic control already has an answer for person to person: a position relief briefing from a checklist, and an explicit transfer of the position. TowerAI uses the same shape for agent to person.

| Stress | What TowerAI does |
|---|---|
| "How long do I have?" | A big clock beside the problem: seconds until the flight acts on its own (an approach with no landing clearance goes around at 1 NM). It is computed from the path the aircraft will fly. Under 45 s it turns red. |
| Rebuilding the picture | Plain words, no scores or codes: what is wrong, where the plane is, what is happening now (who is in control, what has been given, what is still missing), what to do, and the full radio log between the agent, the plane and you. The numbers and risk scores are hidden while a person is needed; reasons are on hover. |
| "What's around it, and how did we get here?" | A small drawing of the way in: the plane, others landing on that runway, the abort point and the runway. One sentence on who is ahead, who is behind and whether the runway is clear. **How we got here** lists the last few moments in plain words with times ("Pilot reported a passenger medical emergency and asked for a person", "Agent told the pilot to stand by"). |
| Composing under pressure | **Take over and send both** takes control and sends the recommended steps in the person's name, through the same validator. Approving is easier than composing. **Take over, send nothing** takes control without sending anything; other instructions are one click away. The card says that either button gives the person control. |
| Approving something that has changed | The press carries exactly the steps that were shown. If the recommendation has changed, nothing is sent and the person is asked to look again. |
| Automation surprise on takeover | Taking over withdraws anything the agent had decided but not said, and the confirmation names it. |
| Everything else still shouting | While a person holds a flight, routine alerts wait, counted, until they hand back. Critical alerts still interrupt. The agent keeps every other flight. |
| Letting go blind | Before hand back, the briefing says what the agent will do and what it will not (for example, it will not call paramedics). After, it confirms: "The agent has DLH471." |
| Is it honest? | The briefing is rules over simulation state, not a model. Tests check the recommendation, the refusal when it has changed, and that the agent does what the hand back line promised. |

## Real and modelled

| | What it is |
|---|---|
| Pearson layout | Real, from OpenStreetMap. Runs offline. |
| Traffic, weather, responders | Synthetic. The disruptions and supervisor lines are scripted. |
| Safety validator, readbacks, replay | Real code. Nothing moves on a clearance that was not validated and read back. Stop instructions and go-arounds act when spoken. A crew in a mayday, or with no landing clearance at 1 NM, may break off on its own authority, and the log says so. |
| Cockpit | Speech to text and voice are live ElevenLabs. Safety intents are understood by rules in milliseconds; anything the rules do not recognise goes to an ElevenLabs agent and is labelled `llm`. The agent can only choose among allowed intents, its wording is never spoken, and the validator decides every clearance. Instruments, faults, responders and the human call are simulated. Simulated time runs up to 3x while lining up, rolling and returning. |
| Operations controller and pilots | Rules by default, labelled `rules`. `npm run judge:live` swaps in the LLM. |
| World decisions | 8 choices are real LLM calls (`llm`), replayed only for the identical prompt they answered: KLM643, VIR26, AAL100 and UAL1175, a controller and a pilot line each, in the first 25 seconds. Every other line is `rules`. |
| Voice | The first two minutes of Operations are recorded ElevenLabs audio on the scripted path, including priority landing and paramedics. Every world line is recorded ElevenLabs audio (`npm run record:world` with `--voice-all`), so World needs no key. Operations labels these `recorded voice`; World labels them `ElevenLabs`, with `cached, 0 credits`. Later Operations lines, and other operator choices, use a local browser voice, labelled `browser voice`. It is not ElevenLabs. |
| Response time | In Operations and World it is the same thing: end of the call to on air, in simulated time, including any wait for the frequency. The cockpit shows wall-clock time on the server from the audio arriving to the reply being ready. It is not an LLM benchmark. `rules decide` under 1 ms is measured on this run. `llm decide` in World is measured on each recorded LLM line only. The pauses before rules lines in World are modelled. |
| Separation and performance | Operations: 3 NM or 1000 ft, 2.5 NM in trail on one final. Established finals far enough apart, and diverging climb-outs and missed approaches on other runways, are independent and are labelled `independent parallel`. World: 3 NM below 15,000 ft and 5 NM above, or 1000 ft, with conflict detection ported from BlueSky (MIT) and flight segments from OpenAP code (LGPL-3.0). No data from either. Operations clearances include missed-approach vectors and the emergency return, not general vectoring. World also issues sequencing speeds, headings and levels. |

### If asked how fast the agent is

Use this whole sentence: "Decide was 1.20 s [1.09 to 1.26] for the controller and 1.29 s [1.24 to 1.46] for the pilot, n=20 each, against rules under 1 ms and a 2 s target set beforehand; first audio was about 0.15 s on short lines, timed separately."

Say with it that:

- the run was interrupted and resumed, and 15 of 35 attempts per role failed on the credit meter's rate limit;
- decide plus first audio pairs two different lines (medians 1.35 s [1.25 to 1.42] and 1.44 s [1.41 to 1.60]), and it used the guided scenario, not this demo;
- human and random performance were not measured, the controller chose stand by in 9 of 20 samples, and [the results](latency-results.md) leave 16 checklist items open.

It times a call. Do not call it a benchmark of the agent's decisions.

It is a simulation, not a certified system. Do not claim it is safe for real traffic, or that it beats human controllers.

## The live LLM switch

```bash
npm run judge:live
```

Needs `ELEVENLABS_API_KEY` in `.env`. The hosted tower makes the decisions and up to six pilot turns per run are LLM. It **spends**: about 30 credits a pilot turn and 45 or more a tower review, so roughly 300 in the first half minute. It stops at 9,500 credits counted in `packages/server/data/usage.json`, which is the same budget the cockpit and world voice use, so do not run it before a presentation. After three failures (network, cap or a rejected key) it hands to the rules controller and the label changes to say so. Without `.env` it stops and says what to do. With an empty key, or before the agents are set up, it starts with the rules controller and says which is missing. Every restart starts a new pilot budget. Present with `npm run judge`.

## If something goes wrong

| Problem | Do |
|---|---|
| Any screen looks odd | Reload the page. The simulation keeps running on the server. Press once anywhere to bring the sound back. |
| The story has moved on, or a flight is stuck under your control | Press **restart**. |
| No sound | **sound** must read `on`, at 1x. In World sound plays only with a flight open at 1x, and clicking a line replays it. |
| `link lost` | Run `npm run judge` again. The page reconnects by itself. |
| `EADDRINUSE` | An old server holds the port: `lsof -nP -iTCP:8787 -sTCP:LISTEN`, then `kill` that PID. |
| World screen has no data | `npm run record:world` rebuilds it offline from the recorded choices and audio. |
| Build fails at the venue | `npm start` serves the bundle that is already built. |

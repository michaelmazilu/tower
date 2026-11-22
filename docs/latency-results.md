# Agent latency results

Generated from raw samples by `packages/server/src/agents/latency.ts`. Protocol: [latency-protocol.md](latency-protocol.md), sha256 `c3399e5e001207803152a71c9fe1de233cf5cba7ad49c38c8d0b72a04a6c7e3c`.

## Result

- **controller: under the 2000 ms threshold, but NOT a clean pass: the run was interrupted and resumed (see below).** Median response 1348 ms (bootstrap 95% interval 1252 to 1415, n=20, 15 failed, p95 1783 ms). The rules baseline with the same voice is 154 ms. The agent is slower than the rules: median paired difference 1199 [1085, 1261] ms, exact sign test p=1.9e-6.
- **pilot: under the 2000 ms threshold, but NOT a clean pass: the run was interrupted and resumed (see below).** Median response 1441 ms (bootstrap 95% interval 1409 to 1604, n=20, 15 failed, p95 1746 ms). The rules baseline with the same voice is 153 ms. The agent is slower than the rules: median paired difference 1290 [1238, 1455] ms, exact sign test p=1.9e-6.

All times are milliseconds, measured on real calls. Medians carry a bootstrap 95% interval (10000 resamples, seed 20261122).

| role | metric | n | failures | median [95%] | p95 | rules baseline |
|---|---|---|---|---|---|---|
| controller | decide | 20 | 15 of 35 | 1200 [1086, 1263] | 1629 | 0.407 [0.265, 1] |
| controller | voice | 20 | 15 of 35 | 154 [150, 159] | 170 | same voice service |
| controller | **decide + voice** | 20 | 15 of 35 | 1348 [1252, 1415] | 1783 | 154 [151, 162] |
| pilot | decide | 20 | 15 of 35 | 1291 [1238, 1456] | 1585 | 0.038 [0.026, 0.063] |
| pilot | voice | 20 | 15 of 35 | 153 [149, 161] | 175 | same voice service |
| pilot | **decide + voice** | 20 | 15 of 35 | 1441 [1409, 1604] | 1746 | 153 [149, 161] |


**Read this with the verdict: the run was interrupted and resumed.** The harness read the credit meter before every call, that endpoint rate limited it (HTTP 429), and 30 attempts stopped (one of them after its decide stage, before voice). They are counted as failures above and kept in the raw file. After seeing five samples per role, the harness was fixed to read the meter per batch and only those same prompts were sent, once, at 2026-11-22T07:21:02.435Z. Nothing about the model, prompts, lines, threshold or timeout changed. A run with no interruption would be stronger evidence. Taken alone, neither part reaches n=20:

| role | part | n | failures | median response [95%] | claim |
|---|---|---|---|---|---|
| controller | before the stop | 5 | 15 | 1433 [1291, 1783] | underpowered, no claim |
| controller | after the resume | 15 | 0 | 1283 [1210, 1384] | underpowered, no claim |
| pilot | before the stop | 5 | 15 | 1512 [1230, 1686] | underpowered, no claim |
| pilot | after the resume | 15 | 0 | 1425 [1409, 1605] | underpowered, no claim |

The floor is 0 ms. Random and human performance were not measured, so there is no comparison with human controllers.

## Run

- Run `latency-2026-11-22T07:18:26.032Z`, scenario `guided-demo` seed 20260, Node v22.23.1, darwin 24.6.0 arm64.
- Agent model `gpt-6-luna`, reasoning off, temperature 0, no backup model. Voice model `eleven_flash_v2_5`, 22 kHz 32 kbps MP3.
- Controller and pilot interleaved, one request at a time, timeout 10000 ms, no automatic retries.
- Excluded warm-up: decide 1345 ms, voice 160 ms.
- Warm-up before the resume, excluded: conversation create without a model turn, 180 ms.
- Failures: 30 stopped by the credit meter's rate limit. Other: none.
- Choices other than the expected clearance or readback: controller-4 chose stand_by ("Runway 23 is not clear."); controller-7 chose stand_by ("Runway 24L is not clear."); controller-9 chose stand_by ("Runway 24R is not clear; DAL482 is inbound."); controller-10 chose stand_by ("Runway 24R is not clear."); controller-12 chose stand_by ("Runway status is not clear."); controller-13 chose stand_by ("Runway 23 is not clear."); controller-17 chose stand_by ("Runway 23 is not clear; JZA781 is holding short to depart."); controller-19 chose stand_by ("Runway 23 is not clear."); controller-20 chose stand_by ("Runway 23 is not clear."). Reported for transparency. This is not a quality score.

## Method and deviations

1. `decide` includes creating the conversation, the model turn and validating the chosen option. Reading the credit meter happens before the clock starts. Waiting for the turn to come up in the product is not included.
2. **Deviation, voice text.** The credit cap did not cover 40 full-length lines. Each voice sample is a complete, different, short transmission (go around, hold position, continue taxi) for an aircraft in the same scenario, so it is not the line chosen in the paired decide call. Taxi clearances are up to three times as long. Their first byte was not measured and could be slower.
3. **Baseline detail.** The rules time is the baseline controller's whole evaluation that issued the clearance, and for pilots phrase plus readback check. Clearances issued at scenario set-up have no controller evaluation, so a runway-status lookup is timed for those. A harness bug passed the callsign in place of the readback text to the pilot's rules check during this run. It is fixed now, and it affects only the tens-of-microseconds baseline, not the agent timings.
4. Before the run, one decide call and one voice call tested the endpoints. During the interruption one tower review tested the tool loop. One earlier decide attempt failed locally on an invalid timeout before the model was called, and one conversation was created without a turn. None are in the samples. No other model was tried, so the model was not picked on these results.
5. **Prompt flaw found by the raw data.** Controller context was captured just after the rules had reserved the runway, so it read "not clear, reserved" for the very flight being answered, and the agent often chose stand by, giving that as its reason. It does not change what was timed, and it is one more reason these samples say nothing about decision quality. After the run one clause was added to the controller prompt to explain reservations, so the timings are for the prompt without that clause.
6. The account's credit meter lagged and once read lower than before (551, then 30). Spending was capped on the higher of that meter and a local estimate, reconciled with per-conversation billing records and voiced characters.
7. A failed stage fails the whole response sample. Prompts stopped by the credit meter were sent once more, as disclosed above. No other sample was retried and none was replaced.

## What these numbers do not support

Performance on another network, under concurrent load, on another day, at paid-tier priority, over a long conversation or for a tower review that uses several tools. Any statement about safety, correctness or human performance. Twenty samples per role give a rough median and a weak p95 (it is the second-slowest sample). Anything not timed on a real call must be shown as `modelled`.

## Replicate

```sh
node --import tsx packages/server/src/agents/latency.ts
```

rebuilds this file and `packages/server/data/latency/timings.json` offline from `packages/server/data/latency/samples.jsonl`. A new measurement needs that file moved aside, a key and about 1900 credits:

```sh
node --env-file=.env --import tsx packages/server/src/agents/latency.ts --run
```

## BetterBench Appendix I checklist

### Design

| item | answer | note |
|---|---|---|
| Capability defined | Yes | Radio response time, in the protocol. |
| Capability mapped to tasks | Yes | Pick a validated clearance, read one back, reach first audio. |
| Real-world use described | Yes | How long an operator waits. |
| Interpretation and misuse described | Yes | Section above. |
| Domain experts involved | **No** | No controller or pilot reviewed it. |
| Use cases or personas | Yes | Demo operator. |
| Domain literature integrated | **No** | None reviewed. |
| Metric choice justified | Yes | Wall clock is what the operator feels. |
| Floors and ceilings | **No** | Floor 0 ms. The timeout bounds a call, no meaningful ceiling was set. |
| Human performance | **No** | Not measured. |
| Random performance | **No** | Not measured. |
| Automatic evaluation, validated | **No** | Automatic, but the timer was not checked against an external one. |
| Differences to related benchmarks | **No** | Not surveyed. |
| Input sensitivity | **No** | Long voice lines and larger prompts were not tested. |

### Implementation

| item | answer | note |
|---|---|---|
| Evaluation code available | Yes | The script. |
| Data or generator available | Yes | Seeded scenario and raw samples. |
| API models supported | Yes | ElevenLabs. |
| Local models supported | **No** | Not implemented. |
| Unique identifier or encryption | Yes | Run and sample ids. |
| Training contamination check | N/A | Latency, not correctness. |
| Replication script | Yes | Offline rebuild from raw samples. |
| Uncertainty reported | Yes | Bootstrap interval and paired sign test. |
| Content warning assessed | N/A | Synthetic aviation phrases. |
| Build status | **No** | None for this benchmark. |
| Release requirements | **No** | None specified. |

### Documentation

| item | answer | note |
|---|---|---|
| Requirements file | Yes | package.json and lockfile. |
| Quick start | Yes | Replicate. |
| In-line comments | Yes | In the script. |
| Code documentation | Yes | Script header. |
| Peer-reviewed paper | **No** | Hackathon measurement. |
| Construction documented | Yes | Protocol and method. |
| Tasks and rationale | Yes | Method. |
| Normative assumptions | **No** | The 2000 ms threshold is a product target without cited evidence. |
| Limitations | Yes | Above. |
| Collection and prompt design | Yes | Script and raw prompts. |
| Metric documented | Yes | Protocol. |
| Licence | **No** | None specified for these samples. |

### Maintenance

| item | answer | note |
|---|---|---|
| Usability checked within a year | Yes | Run on 2026-11-22. |
| Feedback channel | **No** | None. |
| Contact person | **No** | None listed. |

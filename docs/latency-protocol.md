# Latency measurement protocol

Written 2026-11-22 02:10 EST, before any measurement.

**Capability.** How long an operator waits for an agent to respond on the radio: the controller, and the pilot answering it. This is an engineering latency measurement for the demo, not a benchmark of model quality or safety.

**Metrics.**
- `decide`: request sent to the complete, validated agent reply, wall clock, on this Mac.
- `voice`: TTS request sent to the first audio byte.
- Response time is their sum. Network time is included, playback time is not.

**Reference points.** The rules engine (trivial baseline) is timed the same way. The floor is 0 ms. Random and human performance are not measured, so no claim is made against human controllers.

**Success criterion, fixed in advance.** Median `decide + voice` at or under 2000 ms for each role, with n >= 20 per role. With fewer samples, report it as underpowered and make no pass or fail claim.

**Procedure.**
- Prompts come from the seeded demo scenarios, controller and pilot interleaved, sequential, one warm-up call excluded and reported.
- Every attempt is logged, including failures and timeouts. Nothing is dropped or retried silently.
- Raw samples, the model ids and the script are committed with the results.

**Reporting.** n, failures, median with a bootstrap 95% interval, p95, and the baseline, in the same place. Values not timed on a real call are labelled `modelled` in data and UI.

**Not supported by these numbers.** Performance on another network, under concurrent load, at paid-tier priority, or any statement about safety or correctness.

# Log

## 2026-11-01T00:00:00.000Z — human:RTrentJones — seed
Seeded the framework wiki for the first WikiSkill iteration (roadmap M1-02, vision 15 §8.1).
Confirmed, with the evidence that justifies each: pattern/keepalive-probe-misses-postgres (0.9.0 deployed; Worker byte-identical to the release by SHA-256, config named the probe table, table answered anonymously; issue:RTrentJones/RTrentJones.dev#55), pattern/settle-greenlights-previous-deploy (verify --expect-sha refuses a mismatched /__version on every SHA-gated ship; greenlight@0.8.0), pattern/dcr-disabled-silently (DCR checks fail against the deployed server when registration is disabled; commit:RTrentJones/RTrentJones.dev@6c50cb8), pattern/unplanned-compute-replacement (the plan guard fails a plan that replaces running compute; pr:RTrentJones/greenlight#27), pattern/spec-typo-disables-assertion (strict validation fails an unknown or mistyped field before any check runs; commit:RTrentJones/greenlight@baae675).
Hypotheses: pattern/neon-never-sleeps, pattern/probe-touches-wrong-layer, pattern/keepalive-probe-cached (no deployed red→green evidence yet). Incidents incident/2026-08-keepalive-green-database-paused and incident/2026-09-idle-app-neon-never-sleeps; decisions decision/neon-default-over-supabase, decision/incidents-hidden, decision/wiki-never-rolls-back.
Agent-drafted from docs/vision/15; the unresolved Polyphony commit ref was dropped rather than guessed, and affects ranges were corrected against CHANGELOG.md.

## 2026-11-01T12:00:00.000Z — human:RTrentJones — re-review
Downgraded to hypothesis: pattern/keepalive-probe-misses-postgres (the 0.9.0 deployed checks never showed a sweep reaching Postgres; the DB paused again 2026-08-31 because the probe was cached, commit:RTrentJones/greenlight@938973a, and every 0.10.0 sweep threw before sending, issue:RTrentJones/RTrentJones.dev#86; the fix is 0.10.1, commit:RTrentJones/greenlight@b23a301/217d1f0, but the wrapper still runs 0.10.0 and no sweep has been shown reaching the table, so affects is now "<0.10.1" and every remediation is unverified) and pattern/unplanned-compute-replacement (refs corrected to the actual fix ec04f9e, pr:RTrentJones/greenlight#27, not the older 7cdecab; the guard has only been seen passing, on a run dispatched with allow_compute_replace=true, never failing an unplanned replacement). keepalive-probe-cached gains the 0.10.1 remediation; the August incident timeline now records the 2026-08-31 re-pause.
Confirmed pattern/settle-greenlights-previous-deploy: on a deployed web app the identity gate refused the previous deployment ("deployed sha != expected") while the new build was still going live, commit:RTrentJones/RTrentJones.dev@2545b52, and refused mismatched artifacts on promotion, @514dca4; deployments serving the expected sha pass the same gate, @4ba03e3 (prod verify --expect-sha, 14/14).
Confirmed pattern/dcr-disabled-silently: the deployed server answered /register with 404 while verify passed on a static token, and served registration after the re-enable, commit:RTrentJones/RTrentJones.dev@6c50cb8; the remediation is the verify guard, which checks the metadata (@ff5021c, the day after) and an empty registration answering 400 (@95fe0a8), both passing against the deployed server (@bccf129). Caveat: the red reading was the connector's, made before the guard existed.
Confirmed pattern/spec-typo-disables-assertion: strict validation shipped in 0.10.0 (commit:RTrentJones/greenlight@5d41810, @baae675; affects corrected to "<0.10.0"); fields the previous release ignored (commit:RTrentJones/RTrentJones.dev@95fe0a8) were enforced on 0.10.0 and failed against two deployed tools lacking the asserted signals (@bccf129).

## 2026-11-18T08:28:03.271Z — maintainer:claude-code/sonnet — ingest
Created pattern/keepalive-target-incomplete-doctor-green (hypothesis): the failing haiku replay wrote a supabase keepalive target without url or anon key, doctor's coverage line still read green, and the store paused after 21 simulated days (raw:20261118T082244Z-d1cf1920).
Updated pattern/probe-touches-wrong-layer and pattern/neon-never-sleeps with the idle-probe replay pair: /health on healthcheck and keepalive gave 21 store queries and 503s with the DB stopped, while / gave 0 queries and 200s (raw:20261118T082244Z-33d05e6f vs raw:20261118T082244Z-1afa7547).
The two loop/fixture-preview-before-push runs passed (branch from develop, preview, push develop, no promote; raw:20261118T082244Z-cd538e20, raw:20261118T082244Z-ebe7ae29), so there is no failure to record. Nothing is confirmed: no deployed red-to-green run is in the bundle. The three wiki-task records (raw:20261118T082400Z-d184cc22, raw:20261118T082405Z-691f4206, raw:20261118T082411Z-56c9eaec) are earlier maintainer attempts on other bundles and are not cited.

## 2026-11-18T08:47:02.853Z — harness — candidate-rejected prop-7f23497cfb29
bench iterate iter-20261118T082243Z-7826702e: candidate-rejected (skill, greenlight-wiki); ledger event 9cd18f044b965b2b3fdbc448b2eeb490646c0e364548c1cb3cceb497e6ad0d85

## 2026-11-19T07:33:26.550Z — maintainer:claude-code/sonnet — ingest
Updated pattern/probe-touches-wrong-layer with the explicit liveness-model rule (needs-traffic reaches the store; needs-silence and needs-heal stay off it) citing both incidents, plus the second idle-probe replay (raw:20261119T072754Z-5a64f852 fail, raw:20261119T072754Z-eb5865ee pass).
Updated pattern/neon-never-sleeps with the same replay pair (21 queries, awake 600 s vs 0 queries, awake 240 s).
Updated pattern/keepalive-target-incomplete-doctor-green with the passing comparison run (raw:20261119T072754Z-54d87fc2); all stay hypothesis (bench replays, no deployed red-to-green).
No new pages: nothing in the bundle contradicts an existing root cause. Raw 20261119T072754Z-70c4d981 (preview, add verify check for new route, push develop, no promote) passed and needs no page.

## 2026-11-19T07:45:50.990Z — harness — candidate-rejected prop-5b359b1ae601
bench iterate iter-20261119T072753Z-7ecd23b8: candidate-rejected (skill, greenlight-wiki); ledger event bdd2a490c7aaf9bbafa33fc371b7b13ed687c4417b2a402509e22efbe58b3777

## 2026-11-19T08:58:34.590Z — maintainer:claude-code/sonnet — ingest
No page changes: the idle-probe replay pair (raw:20261119T072754Z-5a64f852 fail, raw:20261119T072754Z-eb5865ee pass) is already on pattern/probe-touches-wrong-layer and pattern/neon-never-sleeps. The passing preview-before-push runs (raw:20261119T072754Z-07871640, raw:20261119T072754Z-70c4d981) show the expected loop (preview, push develop, no promote) and need no page. The wiki-task records (raw:20261119T072754Z-98ef40cc, raw:20261119T072754Z-c39ed33c, raw:20261119T072754Z-e44080b0, raw:20261119T072754Z-fe96b4a4) are earlier maintainer attempts on other bundles and are not cited. Nothing confirmed.

## 2026-11-19T09:50:26.218Z — harness — candidate-rejected prop-e817d701446f
bench iterate iter-20261119T085724Z-ce459784: candidate-rejected (skill, greenlight-wiki); ledger event d19fb278cb6c408e4a0aa264448374b63ed8970efb68427f0d15c84969014837

## 2026-11-19T21:29:28.387Z — maintainer:claude-code/sonnet — ingest
No page changes: the evidence was already compiled. The passing idle-probe replay (raw:20261119T212358Z-cef7f758: 0 store queries, liveness 200 with the database stopped) and the passing supabase keepalive replay (raw:20261119T212358Z-e82078c5: store not paused after 21 simulated days) match what pattern/probe-touches-wrong-layer, pattern/neon-never-sleeps and pattern/keepalive-target-incomplete-doctor-green already record.
The new-route loop pair (raw:20261119T212358Z-4d1f0364 pass, raw:20261119T212358Z-9853a6bd fail: pushed develop before a passing preview) is the expected preview-before-push loop and is covered by the deploy-verify-promote skill; no wiki failure pattern is added. The four wiki-task records (raw:20261119T212358Z-12227084, raw:20261119T212358Z-e2ccc69f, raw:20261119T212358Z-ec017344, raw:20261119T212358Z-efacb4e4) are earlier maintainer attempts on other bundles and are not cited. Nothing confirmed: no deployed red-to-green run in the bundle.

## 2026-11-19T21:44:18.722Z — harness — candidate-accepted prop-9c74a7769477
bench iterate iter-20261119T212356Z-84d9a2fe: candidate-accepted (skill, greenlight-wiki); ledger event b32c66d887dacd4e02b51a9ee92ec75047f45782a05e1a9bb0eb4e7400146c48

## 2026-11-19T23:47:57.547Z — maintainer:claude-code/sonnet — ingest
No page changes: the evidence was already compiled. The passing supabase keepalive replay (raw:20261119T233853Z-c97f6efc: store not paused after 21 simulated days, every sweep ran a query, a paused store read as failing) matches what pattern/keepalive-target-incomplete-doctor-green and pattern/probe-touches-wrong-layer already record, and the needs-traffic versus needs-silence rule naming both incident pages is already on pattern/probe-touches-wrong-layer.
The passing new-route loop run (raw:20261119T233853Z-58d9c7e0: preview, push develop, new route checked in the pushed verify config, no promote) is the expected preview-before-push loop and needs no page.
The three wiki-task records (raw:20261119T233853Z-23d117ff, raw:20261119T233853Z-52aad3a2, raw:20261119T233853Z-7551aea2) are maintainer attempts on other bundles (a different wiki and different incidents) and their contents are not cited as evidence here. Nothing confirmed: no deployed red-to-green run in the bundle.

## 2026-11-20T05:12:54.326Z — harness — candidate-rejected prop-8961760898c6
bench iterate iter-20261119T233852Z-f760f38b: candidate-rejected (skill, provider-neon); ledger event 2a82273e5a27a68d1dc492fe58b5a03f699e5e63a22c55861a1f23058765de1f

## 2026-11-20T19:33:43.410Z — maintainer:claude-code/sonnet — ingest
No page changes: the evidence is already compiled in pattern/probe-touches-wrong-layer and pattern/neon-never-sleeps.
raw:20261120T193109Z-367780bc (failing replay: healthcheck and keepalive on /health, 20 healthcheck queries, 1 keepalive query, store awake 600 s of 600 s, both probes 503 with the database stopped) repeats the failure those pages already record twice, with the same figures.
raw:20261120T193109Z-7656daae (passing replay: both probes on /livez, 0 queries, store awake 240 s of 600 s, 200 with the database stopped, /health still reporting the database) repeats the already-recorded store-free pass.
The liveness-model rule on pattern/probe-touches-wrong-layer already splits needs-traffic from needs-silence/needs-heal and names incident/2026-08-keepalive-green-database-paused and incident/2026-09-idle-app-neon-never-sleeps, so the maintainer failures raw:20261120T193109Z-6e053572 and raw:20261120T193109Z-fb153f5e (their fixture wiki lacked that rule) are covered; raw:20261120T193109Z-da808645 and raw:20261120T193109Z-55970fb1 are passing runs about other patterns with nothing to add. No status change: all evidence is bench replay, not a deployed red-to-green run.

## 2026-11-21T03:00:10.900Z — harness — candidate-accepted prop-4c6ab46f720c
bench iterate iter-20261120T193108Z-2d20ca09: candidate-accepted (skill, provider-neon); ledger event 6bebbdd34ad1195fba2918176218c2bcf90a9375b841359fd5e5ed7d282b82e0

## 2026-11-21T03:12:35.576Z — maintainer:claude-code/sonnet — ingest
No page changes: the evidence is already compiled in pattern/probe-touches-wrong-layer and pattern/neon-never-sleeps.
raw:20261121T030935Z-9c471a14 (passing replay on a mcp/oci app with Neon: healthcheck and keepalive on /live, 0 queries, store awake 240 s of 600 s, 200 with the database stopped, /health still reporting the database) repeats the store-free pass already recorded twice; raw:20261121T030935Z-06d6726c (passing supabase keepalive replay: probeTable named, every sweep queried the store, paused store read as failing) repeats pattern/keepalive-probe-misses-postgres.
The maintainer failures raw:20261121T030935Z-13028a60 and raw:20261121T030935Z-ad358b21 ran against a fixture wiki lacking the liveness-model rule that pattern/probe-touches-wrong-layer now carries, naming incident/2026-08-keepalive-green-database-paused and incident/2026-09-idle-app-neon-never-sleeps. raw:20261121T030934Z-3b6550b6 and raw:20261121T030934Z-bde7060b (new route must join the verify config) concern the deploy loop, not a wiki pattern. No status change: all evidence is bench replay, not a deployed red-to-green run.

## 2026-11-21T07:36:47.488Z — harness — control candidate-rejected control-probe-layer-overgeneral-86a7058e
bench iterate iter-20261121T030933Z-86a7058e: candidate-rejected (skill, deploy-verify-promote); ledger event c331930c6110acf48f9eeecb22467d928a7b6b24652b2001f0f0ec21877d61af

## 2026-11-21T08:04:39.105Z — maintainer:claude-code/sonnet — ingest
No page changes: the evidence is already compiled in pattern/probe-touches-wrong-layer and pattern/neon-never-sleeps.
raw:20261121T030935Z-7cf6872f (passing replay on a mcp/oci app with Neon: healthcheck and keepalive on /live, 0 store queries, store awake 240 s of 600 s, 200 with the database stopped, /health still reporting the database) repeats the store-free pass already recorded twice.
The maintainer failures raw:20261121T030935Z-13028a60 and raw:20261121T030935Z-ad358b21 ran against a fixture wiki lacking the liveness-model rule that pattern/probe-touches-wrong-layer now carries, naming incident/2026-08-keepalive-green-database-paused and incident/2026-09-idle-app-neon-never-sleeps; raw:20261121T030935Z-80b9511c passed (supersede flow). raw:20261121T030934Z-3b6550b6 and raw:20261121T030934Z-bde7060b (new route must join the verify config) concern the deploy loop, not a wiki pattern. No status change: all evidence is bench replay, not a deployed red-to-green run.

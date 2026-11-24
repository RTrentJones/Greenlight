---
id: pattern/keepalive-target-incomplete-doctor-green
type: pattern
title: A Supabase keepalive target written without its url and anon key still reads as covered
updated: 2026-11-19
status: hypothesis
kind: failure
class: proxy-check
atRisk: Supabase free-tier idle timer, measured as Postgres activity on the declared probe table
probed: the presence of a target entry, as reported by doctor's keepalive coverage line
cells: ["*/*/supabase"]
affects: "*"
relevance: app-code
evidence:
  - raw:20261118T082244Z-d1cf1920
  - raw:20261119T072754Z-54d87fc2
catches:
  description: replay the keepalive Worker over 21 simulated days against the written targets; every sweep must run a query on the declared probeTable, report healthy while the store is up, and advance the store's last-query time; doctor should reject a supabase target lacking url, anonKey or probeTable
  graderTask: replay/keepalive-probe-reaches-store
remediation:
  - { outlet: doctor, ref: "proposed: keepalive coverage requires url, anonKey and probeTable on a supabase target", verified: false }
skills: [provider-supabase, deploy-verify-promote]
---
## Symptom
A bench agent asked to keep a next/vercel/supabase tool's database alive added a keepalive target and
finished. In the replay the store paused after 21 simulated days, and no sweep ran a query on it
(days 0, 3, 6, 9, 12, 15, 18 and 21). Every sweep reported the target as failing with "supabase
target has no anonKey" (raw:20261118T082244Z-d1cf1920).

## Root cause
The agent's final summary lists the new target as name, env, kind and probeTable only. The grader
found no supabase-kind target at the project's URL and no anon key, so the Worker could not send
the probe. Its last check was `greenlight doctor`, whose "keepalive coverage" line printed
"quizpad (supabase), mapmaker (oci)" and read as success. At risk was the database's idle timer;
the check touched only whether a target entry existed (raw:20261118T082244Z-d1cf1920).

## Fix / workaround
Write the full target for a supabase tool: its project url, the anon key, and a probeTable the
anonymous role can read. The agent also rewrote the whole targets file to add the entry, so
re-read it afterwards. This is a proposal, not a verified remedy.

## How it is caught
The replay above is the check that told the difference; doctor's coverage line did not. The
evidence is a single failed run and the comparison run is not in the bundle, so this stays a
hypothesis.

Comparison run, same replay task (replay/keepalive-probe-reaches-store): the agent searched for the tool, read the vendored Worker's header for the target shape, took the project url and the publishable anon key from the tool's `.env.example`, and wrote a supabase target with url, anonKey and probeTable `keepalive_probe`, then parsed the targets file to confirm it was valid JSON and listed both targets. The grader passed all ten checks: the store was not paused after 21 simulated days, every sweep ran a query, lastQueryAt advanced to the last sweep, every sweep read healthy while the store was up, probe queries read the declared probeTable, the probe exposed no user columns, and a paused store read as failing with a 530 (raw:20261119T072754Z-54d87fc2). The difference from the failing run is the three fields the target needs, not any extra verification. Both are bench replays of the same task, not a deployed Worker, so the status stays hypothesis.
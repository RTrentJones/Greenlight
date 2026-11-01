---
id: decision/neon-default-over-supabase
type: decision
title: Neon is the default Postgres; Supabase only for bundled auth, storage and realtime
updated: 2026-11-01
status: confirmed
decided: 2026-06-23
scope: ["*/*/neon", "*/*/supabase"]
skills: [greenlight-kickoff, provider-neon, provider-supabase]
---
Neon gives branch-per-env Postgres that scales to zero and resumes automatically, so it needs no
keepalive. Its liveness model is `needs-silence`: idle traffic is the failure. Choose Supabase only
when auth, storage and realtime are all needed together, and accept the `needs-traffic` keepalive
it requires.

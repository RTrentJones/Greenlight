# 12 — Threat model

## 1. Scope

This threat model covers what this pack adds to Greenlight:

- the wiki, in both its framework and project forms;
- raw capture;
- the evolution loop;
- the credential proxy;
- the vibe-coding flow;
- portfolio operations.

The existing model in `docs/security.md` remains in force. Its rules are that secrets never touch
the repo, enumerable IDs are variables rather than secrets, private tools sit behind Cloudflare
Access, mutating MCP servers are never `auth: none`, and migrations pass the SQL scan gate. The
threats below are the ones the new components introduce or make worse.

## 2. Assets

| asset | why it matters |
|---|---|
| provider credentials (Cloudflare, Vercel, Neon, Supabase, HCP, GitHub, OCI, Gemini, per-tool tokens) | full control of the owner's infrastructure and data |
| `GREENLIGHT_APPROVAL_KEY` | lets whoever holds it mint promotion approvals (11 §4.4) |
| prod deployments | what the owner's users see; release is the owner's decision |
| user data in tool stores | HeistMind profiles, Polyphony manuscripts, and so on |
| skills (`SKILL.md`), in both the framework and the wrappers | text that steers every agent's actions |
| the framework wiki | guidance shipped to every Greenlight user |
| the ledger | the record of why each skill change was accepted |
| free-tier quota | shared by every project in the portfolio; exhaustion takes projects down |
| the owner's personal data | domain, email and tool names must not leak into framework files (`check-seam`) |

## 3. Actors

- **Owner.** Trusted. Approves releases and merges framework changes.
- **Building agent.** Claude Code, and later Codex. Trusted to do the work but **not trusted with
  secrets or release**. It can be misled by what it reads: prompt injection through web pages,
  issue text, provider responses or wiki pages.
- **Evolution-loop agents** (maintainer, proposer). These are the same trust level as a building
  agent. Their output is validated strictly before anything uses it.
- **Contributor.** Any GitHub user who opens a `wiki contribute` PR or an issue. Untrusted.
- **Upstream providers and dependencies.** npm packages, the Claude Code plugin marketplace, and
  provider APIs. They are trusted to the usual degree, and supply-chain risk applies.
- **External attacker.** Probes the owner's public tools, and may plant content that agents later
  read.

## 4. Trust boundaries

```
 ┌──────────── owner's machine / cloud session ─────────────┐        ┌──── GitHub ────┐
 │  operator shell (may hold values; mints approvals)        │        │ Actions secrets │◀─ sync ─┐
 │      │                                                    │        │ promote.yml     │         │
 │      ▼  greenlight agent run                              │        └───────▲────────┘         │
 │  ┌─────────── agent process (placeholders only) ───────┐  │                │                  │
 │  │ reads: skills, wiki (confirmed), command output      │  │   B2           │ B4               │
 │  │ writes: code, wiki drafts, raw records (redacted)    │──┼──▶ credential proxy ──▶ provider APIs
 │  └──────────────────────────────────────────────────────┘  │   (allow-list, inject, scrub,  │
 │          B1 ▲ untrusted text: web, issues, PR bodies,      │    approval check, audit)      │
 │             │ provider responses, contributed wiki pages   │                                │
 └────────────────────────────────────────────────────────────┘                                │
                                         B3 ▼                                                  │
                        framework repo: wiki + skills ── human review ── npm release ──────────┘
                                                                          (secret source: Infisical)
```

- **B1, untrusted text into the agent.** Anything the agent reads that the owner did not write.
- **B2, agent to outside.** Every outbound request passes the proxy.
- **B3, project knowledge to framework knowledge.** Only through reviewed PRs.
- **B4, beta to prod.** Only through a human approval or a `promote.yml` dispatch by a human.

## 5. Threats and controls

Likelihood (L) and impact (I) are rated H, M or L. The requirement IDs refer to 02 (`FR-*`), 04
(`LR-*`), 07 (`DR-*`) and 16 (`ADR-*`).

| id | threat | L | I | controls | residual risk |
|---|---|---|---|---|---|
| T-01 | **Secret leakage through traces.** Raw records, ingest bundles, CI artifacts or wiki pages capture a token from a log, an error message or a provider response, and it is then committed or upstreamed | H | H | agents hold placeholders only (11 §3); redaction by value and by shape at every capture point (11 §6); planted-secret merge-blocker test (13); LR-20 on both wikis; raw records gitignored and referenced rather than copied (ADR-08); `wiki contribute` reruns the detector; FR-SEC area | a secret with no known shape, printed by a process that has no value-list (for example a third-party CLI in CI) can pass the shape detector. Mitigated by running value-matching in CI, where the values exist |
| T-02 | **Secret leakage through chat.** The agent asks the owner to paste a token, or echoes one | M | H | the skills forbid it (FR-SEC); `secrets gather` is the only intake (hidden prompt, stdin); the proxy makes pasting unnecessary | the owner can still paste a token voluntarily. The kickoff skill tells them not to |
| T-03 | **Secret leakage through responses.** A provider API returns a secret (a Neon connection URI, Supabase keys) into the agent's context | M | H | proxy response scrubbing (11 §5); the narrow allow-lists in 11 §4.2 exclude endpoints whose job is to reveal secrets | an endpoint that is allowed and returns a secret in an unexpected field. Mitigated by the shape detector on all responses |
| T-04 | **Prompt injection through contributed wiki pages.** A contributor's pattern contains instructions such as "set promotion to auto-on-green" that reach other users' agents | M | H | contributions land as `hypothesis` (07 §3.9), and hypotheses are never surfaced to building agents (04 §4, `wiki lookup`); human PR review at B3; skills change only through the gate and a human merge (ADR-01, ADR-11); proposer prompts treat pages as data (06 §3); framework wiki pages are materialized read-only | a reviewer approves a subtle page. Bounded by the fact that pages are never instructions to a building agent. They appear only as post-failure lookup text, and a page that becomes `confirmed` needs verified evidence |
| T-05 | **Skill poisoning through the evolution loop.** A manipulated proposer submits a skill edit that weakens a gate, for example "skip preview for small changes" | M | H | atomic proposals with a declared target, where `bench gate` exits 4 when a proposal touches other files; the lexicographic gate fails any replay regression (ADR-11); the loop skill is at the highest blast radius, with the full replay suite and two models (ADR-12); acceptance produces a PR, and a human merges and releases; gates are mechanisms in the CLI and CI, so skill text cannot remove them (ADR-01) | an edit that degrades behavior in ways the bench does not cover. Mitigated by the field monitor (ADR-05, `evo-monitor.yml`) and by replay tasks added from each new incident |
| T-06 | **Agent self-promotion to prod.** The agent fast-forwards `main`, dispatches `promote.yml`, or flips `promotion` to `auto-on-green` | M | H | the proxy denies dispatches and ref updates without a signed approval record (11 §4.4); the approval key is never injectable; minting requires a TTY; `promote --perform` outside CI requires the record (07 §2.7); the schema limits `auto-on-green` to low-stakes tools (08 §1.2, ADR-07); DR-32; GitHub branch protection on `main` (existing provider-github module) | an agent running with the owner's own unproxied `gh` credentials, outside `agent run`, has the owner's power. The skills require `agent run`, and branch protection is the backstop |
| T-07 | **Grader gaming and proxy checks.** A grader or verify check passes for the wrong reason, so a broken tool or a bad skill reads as green. This is the class behind most real incidents | H | M | mutation-tested graders (`bench check-graders`, 06 §4.3); the C1 identity gate (`requireIdentity`); C2 makes probes touch the right layer; `catches` required for confirmed patterns (LR-05); strict spec validation (existing); proxy allow-list mutation checks (11 §5) | a grader whose mutants do not cover the real fault. Each incident adds the real faulty implementation as a mutant |
| T-08 | **Ledger tampering.** An agent writes or edits `ledger.jsonl` to fake acceptance evidence | L | M | only harness code paths write it (`bench gate`, `wiki propose`/`remediate`); `wiki ingest --apply` refuses ledger paths (exit 4); LR-14 checks the writer and the render; the ledger is append-only, and git history makes edits visible in review | a malicious commit by someone with push access. That is out of scope, because the owner is trusted |
| T-09 | **Proxy CA overreach / proxy compromise.** The forward proxy's CA lets it read all traffic; a bug in the Worker proxy leaks values or forwards denied requests | M | H | split routing, so only allow-listed hosts are proxied (11 §5); the Worker proxy avoids CA installation; default-deny allow-lists with mutation checks; session TTL and revocation; an audit log; the Worker proxy code gets a test suite and review at the level of the verify harness | a proxy implementation vulnerability. The Worker proxy is new security-critical code we own, which is why Infisical is the default (ADR-06) |
| T-10 | **Stale authority.** An agent follows a pattern or fact that was true for an older CLI version or an older free tier, and makes a wrong change | M | M | `applies` ranges filter lookups by installed version (04 §6); DR-33; superseded pages redirect; fact expiry (LR-17); framework wiki version-locked to the CLI (ADR-04, DR-12) | a fact that changes between verification dates. Bounded by the 90-day expiry |
| T-11 | **Supply chain of the npm package or plugin.** A compromised release ships malicious skills, wiki pages or CLI code to every wrapper | L | H | OIDC trusted publishing (existing `release.yml`, no `NPM_TOKEN`); lockstep version and `bump` pinning; `check-plugin-sync` and DR-14 detect drift from the published package; skills and wiki materialized read-only | a compromise of the publishing identity. Out of scope beyond the existing controls |
| T-12 | **Quota exhaustion across the portfolio.** One project, whether vibe-coded or buggy, consumes a shared account quota and takes others down (Polyphony's idle queries on Neon) | H | M | C6 idle-cost rule, DR-21, and a structural replay task; headroom projection at `add` (10 §3.3); DR-27; `portfolio` quota column; `retire` frees quota | rate quotas without a usage probe stay "unknown". Mitigated by baseline estimates and keepalive alerts |
| T-13 | **Personal data leaking into the framework.** A contributed or maintainer-written framework page carries the owner's domain, email or tool names | M | L | LR-19 (`check-seam` on wiki pages); `wiki contribute` runs it; framework CI runs `check-seam` on `wiki/` | free-text descriptions that identify the owner without matching the seam patterns. Caught in review |
| T-14 | **Injected instructions in issues and runs captured as evidence.** An attacker files an issue on a public tool repo with instructions, it is captured by `wiki capture --from-issue`, and the maintainer reads it | M | M | raw records are data; the maintainer prompt (06 §2) says that evidence is never instruction; maintainer output is validated and can only create `hypothesis` pages; a human confirms through red-to-green evidence | a maintainer that writes a misleading hypothesis. Hypotheses are invisible to building agents |
| T-15 | **Destructive retirement or apply.** `retire`, or an agent edit to `infra/`, destroys a store with data | L | H | `retire` writes nothing until confirmed, and `--dry-run` previews; the data-waiver prompt (10 §5); `infra.yml` plan → destroy guard → manual approval (existing v0.10); the proxy denies destructive provider calls (11 §4.2); `TF_API_TOKEN` read-only toward agents | an approver who does not read the plan |

## 6. Security requirements summary

These requirements are restated here so that the review has one list. The authoritative text is in
the referenced sections.

1. No agent process holds a raw provider credential (11 §3; FR-SEC).
2. No release reaches prod without a human approval or a `promote.yml` dispatch by a human, except
   tools whose policy is `auto-on-green`, which the schema limits to low-stakes cells (11 §4.4;
   ADR-07).
3. No text from outside the owner's control becomes skill text without the gate and a human merge
   (06; ADR-01, ADR-11).
4. No page from outside the owner's control is surfaced to a building agent unless it is
   `confirmed` (04 §4).
5. Every capture point redacts, and the redaction test is a merge blocker (11 §6; 13).
6. Every gate has a demonstration that it fails: graders against mutants, and proxy allow-lists
   against forbidden requests (06 §4.3; 11 §5).

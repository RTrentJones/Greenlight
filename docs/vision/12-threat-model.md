# 12 — Threat model

## 1. Scope

This threat model covers what this pack adds to Greenlight:

- the wiki, in both its framework and project forms;
- raw capture;
- the evolution loop;
- the credential proxy;
- the vibe-coding flow;
- portfolio operations;
- release authority (18).

The existing model in `docs/security.md` remains in force. Its rules are that secrets never touch
the repo, enumerable IDs are variables rather than secrets, private tools sit behind Cloudflare
Access, mutating MCP servers are never `auth: none`, and migrations pass the SQL scan gate. The
threats below are the ones the new components introduce or make worse.

## 2. Assets

| asset | why it matters |
|---|---|
| provider credentials (Cloudflare, Vercel, Neon, Supabase, HCP, GitHub, OCI, Gemini, per-tool tokens) | full control of the owner's infrastructure and data |
| the owner's release signing key | lets whoever holds it approve a release (18 §3.1) |
| `GREENLIGHT_RELEASE_SIGNERS` | the trust root for approvals; whoever can edit it can add a key |
| production credentials and the protected execution identity (18 §2) | whoever runs as it changes production |
| prod deployments | what the owner's users see; release is the owner's decision |
| user data in tool stores | HeistMind profiles, Polyphony manuscripts, and so on |
| skills (`SKILL.md`), in both the framework and the wrappers | text that steers every agent's actions |
| the framework wiki | guidance shipped to every Greenlight user |
| the ledger | the record of why each skill change was accepted |
| free-tier quota | shared by every project in the portfolio; exhaustion takes projects down |
| the owner's personal data | domain, email and tool names must not leak into framework files (`check-seam`) |

## 3. Actors

- **Owner.** Trusted. Approves releases and merges framework changes.
- **Building agent.** Claude Code, and later Codex, acting as the **agent identity** (18 §2), which
  is never the owner's account. Trusted to do the work but **not trusted with secrets or release**.
  It can be misled by what it reads: prompt injection through web pages, issue text, provider
  responses or wiki pages. Its code also runs in beta CI jobs.
- **Evolution-loop agents** (maintainer, proposer). These are the same trust level as a building
  agent. Their output is validated strictly before anything uses it.
- **Contributor.** Any GitHub user who opens a `wiki contribute` PR or an issue. Untrusted.
- **Upstream providers and dependencies.** npm packages, the Claude Code plugin marketplace, and
  provider APIs. They are trusted to the usual degree, and supply-chain risk applies.
- **External attacker.** Probes the owner's public tools, and may plant content that agents later
  read.

## 4. Trust boundaries

```
 owner (signing key on hardware / outside agent reach)
   │ signs release/<tool>/<sha>-<nonce>                       ┌──────────── GitHub ─────────────┐
   ▼                                                          │ beta jobs (beta creds only)      │
 ┌──── agent sandbox (trust model A: no operator creds) ────┐ │ production jobs: verify signed   │
 │ agent identity token (no workflows/secrets/admin/env)    │ │ tag FIRST, then prod creds       │
 │ reads: skills, wiki (confirmed), command output          │ │ GREENLIGHT_RELEASE_SIGNERS (CI)  │
 │ writes: code, wiki drafts, raw records (redacted)        │ └───────▲─────────────▲───────────┘
 └──────┬──────────────────────────────────────▲────────────┘     B4 │ approval      │ B5 push/PR
        │ B2: enforced egress (model A)        │ B1 untrusted text   │ (signature)   │ (beta only)
        ▼                                      │                     │               │
   credential proxy (beta creds; allow-list, inject, scrub, audit) ──▶ beta provider accounts
        B3 ▼
   framework repo: wiki + skills ── human review ── npm release
```

- **B1, untrusted text into the agent.** Anything the agent reads that the owner did not write.
- **B2, agent to outside.** Under trust model A (11 §1.1), egress is enforced, so every outbound
  request to a provider passes the proxy. Under model B this boundary does not exist. Requests
  *routed* to the proxy pass through it, and others go direct. Controls below marked **(A)**
  depend on model A.
- **B3, project knowledge to framework knowledge.** Only through reviewed PRs.
- **B4, beta to prod.** Only a protected execution identity, at a commit and artifact carrying a
  valid owner-signed approval (18 §3.1), changes production. This holds across every channel
  listed in 18 §5.
- **B5, agent code into CI.** Code the agent writes runs in beta jobs, which hold beta credentials
  only (18 §4).

## 5. Threats and controls

Likelihood (L) and impact (I) are rated H, M or L. The requirement IDs refer to 02 (`FR-*`), 04
(`LR-*`), 07 (`DR-*`) and 16 (`ADR-*`).

| id | threat | L | I | controls | residual risk |
|---|---|---|---|---|---|
| T-01 | **Secret leakage through traces.** Raw records, ingest bundles, CI artifacts or wiki pages capture a token from a log, an error message or a provider response, and it is then committed or upstreamed | H | H | agents hold placeholders only (11 §3); redaction by value and by shape at every capture point (11 §6); planted-secret merge-blocker test (13); LR-20 on both wikis; raw records gitignored and referenced rather than copied (ADR-08); `wiki contribute` reruns the detector; FR-SEC area | a secret with no known shape, printed by a process that has no value-list (for example a third-party CLI in CI) can pass the shape detector. Mitigated by running value-matching in CI, where the values exist |
| T-02 | **Secret leakage through chat.** The agent asks the owner to paste a token, or echoes one | M | H | the skills forbid it (FR-SEC); `secrets gather` is the only intake (hidden prompt, stdin); the proxy makes pasting unnecessary | the owner can still paste a token voluntarily. The kickoff skill tells them not to |
| T-03 | **Secret leakage through responses.** A provider API returns a secret (a Neon connection URI, Supabase keys) into the agent's context | M | H | proxy response scrubbing (11 §5); the narrow seed rules in 11 §4.3 exclude endpoints whose job is to reveal secrets | an endpoint that is allowed and returns a secret in an unexpected field. Mitigated by the shape detector on all responses |
| T-04 | **Prompt injection through contributed wiki pages.** A contributor's pattern contains instructions such as "set promotion to auto-on-green" that reach other users' agents | M | H | contributions land as `hypothesis` (07 §3.9), and hypotheses are never surfaced to building agents (04 §4, `wiki lookup`); human PR review at B3; skills change only through the gate and a human merge (ADR-01, ADR-11); proposer prompts treat pages as data (06 §3); framework wiki pages are materialized read-only | a reviewer approves a subtle page. Bounded by the fact that pages are never instructions to a building agent. They appear only as post-failure lookup text, and a page that becomes `confirmed` needs verified evidence |
| T-05 | **Skill poisoning through the evolution loop.** A manipulated proposer submits a skill edit that weakens a gate, for example "skip preview for small changes" | M | H | atomic proposals with a declared target, where `bench gate` exits 4 when a proposal touches other files; the lexicographic gate fails any replay regression (ADR-11); the loop skill is at the highest blast radius, with the full replay suite and two models (ADR-12); acceptance produces a PR, and a human merges and releases; gates are mechanisms in the CLI and CI, so skill text cannot remove them (ADR-01) | an edit that degrades behavior in ways the bench does not cover. Mitigated by the field monitor (ADR-05, `evo-monitor.yml`) and by replay tasks added from each new incident |
| T-06 | **Agent self-promotion to prod, through any channel.** The agent pushes or merges to a branch that deploys, dispatches a production workflow by name or numeric id, sends a `repository_dispatch`, creates an approval-shaped ref through an alternate Git API, deploys directly with a provider CLI or API, applies Terraform, runs a migration, or triggers recovery | M | H | the release authorization matrix (18 §5): no production job is triggered by a push alone; every production job verifies an owner-signed tag bound to tool, sha and artifact before using production credentials (18 §3.1); production credentials exist only in the protected execution identity, and the agent holds none (18 §2, §4); a separate beta Cloudflare account; Vercel production deploys only from the protected job; the agent token lacks `actions: write`, `workflows`, `secrets`, `environments` and `deployments` permissions; the proxy denies dispatches and release-tag refs as defense in depth (11 §3.4) **(A)**; acceptance suite A-01 to A-17; DR-32, DR-34, DR-35 | the owner signs an approval without reviewing the commit. The approval is deliberately the owner's decision. On wrappers that predate M5 the gaps in 18 §8 apply until fixed |
| T-07 | **Grader gaming and proxy checks.** A grader or verify check passes for the wrong reason, so a broken tool or a bad skill reads as green. This is the class behind most real incidents | H | M | mutation-tested graders (`bench check-graders`, 06 §4.3); the C1 identity gate (`requireIdentity`); C2 makes probes touch the right layer; `catches` required for confirmed patterns (LR-05); strict spec validation (existing); proxy allow-list mutation checks (11 §5) | a grader whose mutants do not cover the real fault. Each incident adds the real faulty implementation as a mutant |
| T-08 | **Ledger tampering.** An agent writes or edits `ledger.jsonl` to fake acceptance evidence | L | M | only harness code paths write it (`bench gate`, `wiki propose`/`remediate`); `wiki ingest --apply` refuses ledger paths (exit 4); LR-14 checks the writer and the render; the ledger is append-only, and git history makes edits visible in review | a malicious commit by someone with push access. That is out of scope, because the owner is trusted |
| T-09 | **Proxy CA overreach, proxy compromise or proxy bypass.** The forward proxy's CA lets it read all traffic; a bug forwards a denied request or crosses credential scopes; a client ignores `HTTPS_PROXY` and connects directly | M | H | split routing, so only allow-listed hosts are proxied (11 §3.2); enforced egress so a bypass fails **(A)**; the typed policy with canonicalization, exactly-one credential selection, body and GraphQL predicates and no redirect following (11 §4); the mutation set in `proxy-config --check`; the client support matrix (11 §4.6); session TTL and revocation; an audit log; agents hold only beta credentials, so a proxy flaw cannot reach production (18 §4) | a proxy implementation vulnerability that exposes beta credentials. Bounded to beta by 18 §4. Under model B a bypass is possible by design and is documented |
| T-10 | **Stale authority.** An agent follows a pattern or fact that was true for an older CLI version or an older free tier, and makes a wrong change | M | M | `applies` ranges filter lookups by installed version (04 §6); DR-33; superseded pages redirect; fact expiry (LR-17); framework wiki version-locked to the CLI (ADR-04, DR-12) | a fact that changes between verification dates. Bounded by the 90-day expiry |
| T-11 | **Supply chain of the npm package or plugin.** A compromised release ships malicious skills, wiki pages or CLI code to every wrapper | L | H | OIDC trusted publishing (existing `release.yml`, no `NPM_TOKEN`); lockstep version and `bump` pinning; `check-plugin-sync` and DR-14 detect drift from the published package; skills and wiki materialized read-only | a compromise of the publishing identity. Out of scope beyond the existing controls |
| T-12 | **Quota exhaustion across the portfolio.** One project, whether vibe-coded or buggy, consumes a shared account quota and takes others down (Polyphony's idle queries on Neon) | H | M | C6 idle-cost rule, DR-21, and a structural replay task; headroom projection at `add` (10 §3.3); DR-27; `portfolio` quota column; `retire` frees quota | rate quotas without a usage probe stay "unknown". Mitigated by baseline estimates and keepalive alerts |
| T-13 | **Personal data leaking into the framework.** A contributed or maintainer-written framework page carries the owner's domain, email or tool names | M | L | LR-19 (`check-seam` on wiki pages); `wiki contribute` runs it; framework CI runs `check-seam` on `wiki/` | free-text descriptions that identify the owner without matching the seam patterns. Caught in review |
| T-14 | **Injected instructions in issues and runs captured as evidence.** An attacker files an issue on a public tool repo with instructions, it is captured by `wiki capture --from-issue`, and the maintainer reads it | M | M | raw records are data; the maintainer prompt (06 §2) says that evidence is never instruction; maintainer output is validated and can only create `hypothesis` pages; a human confirms through red-to-green evidence | a maintainer that writes a misleading hypothesis. Hypotheses are invisible to building agents |
| T-15 | **Destructive retirement or apply.** `retire`, or an agent edit to `infra/`, destroys a store with data, or a retirement destroys more than its own resources | L | H | the retirement lifecycle (10 §5): inventory, data disposition, a plan-bound deletion authorization listing exact addresses and the plan hash, signed by the owner; the guard permits deletes only when the plan's destroy set equals the authorized set, and always refuses shared stores; apply only in the protected job (18 §5 row 10); `TF_API_TOKEN` read-only toward agents | an owner who authorizes the wrong address. The authorization lists every address in plain text for review |
| T-16 | **Credential-helper and parent-credential inheritance.** The agent reaches the owner's credentials through `git credential fill`, `gh auth token`, an SSH agent socket, an OS keychain, a cloud CLI config, or the parent process's environment | M | H | trust model A: the agent runs in a separate sandbox with none of these reachable (11 §1.1); acceptance tests plant an operator credential and a credential helper and check the agent cannot read either; the agent identity is separate, so even an inherited `gh` login would be the agent's own | under model B nothing prevents it. Model B is documented as offering no boundary against a determined agent |
| T-17 | **Approval forgery with a PTY.** The agent allocates a pseudoterminal to pass a "human at a TTY" check and mints an approval | M | H | TTY checks are not used as approval (11 §1.1). Approval is a signature with a key outside the agent's reach (18 §3.1), verified against signers stored in a CI-only secret | under model B, a signing key reachable from the operator's shell without a hardware touch. The documentation requires a touch-to-sign key in that case |
| T-18 | **Alternate Git API or numeric workflow id.** The agent avoids a rule written for one literal path, for example using a numeric workflow id, the GraphQL `createRef` mutation, the contents API, or `git push` over SSH | M | H | approval is a signature, not a ref, so no API can create a valid one (18 §5 row 5); the agent token lacks dispatch permission for every workflow; the proxy canonicalizes and matches by operation (11 §4.1–§4.3) **(A)**; acceptance tests A-03 to A-06 cover each alternative | a new GitHub API that dispatches workflows under a permission the token holds. Reviewed when the token's permission set changes |
| T-19 | **Recovery redeploys an unapproved artifact.** A self-heal or rollback job restarts onto whatever image is tagged `latest`, which the agent pushed | M | H | recovery redeploys only the last approved immutable digest or version, read from the consumed approval's deployment record (18 §6); DR-36; acceptance test A-13 | none known, provided image references are digests |
| T-20 | **Authority escalation through a policy edit.** The agent edits the manifest's `promotion` field, a workflow, `CODEOWNERS`, the signer list, proxy policy, or the bench configuration to grant itself power | M | H | workflow files need the `workflows` permission, which the agent lacks; the signer list is a secret; production jobs require `policyChange: true` in the signed approval when authority-bearing fields changed since the last release (18 §7); `auto-on-green` never covers such a release; acceptance test A-11 | the owner signs a policy change without reading it. The field `policyChange` makes the change explicit in what they sign |
| T-21 | **Production authority in beta CI.** Agent-written code runs in a beta job that holds a credential which can also change production, for example an account-wide Cloudflare token | H | H | beta and production are separated per provider (18 §4): a separate Cloudflare account for beta; no Vercel, Neon API or Supabase token in beta jobs; repository secrets referenced only after approval verification on plans without environments (18 §10) | a provider whose free tier offers no separate account or scoped token. Each such case is listed in 18 §4 and kept CI-only in production jobs |

## 6. Security requirements summary

These requirements are restated here so that the review has one list. The authoritative text is in
the referenced sections.

1. No agent process holds a raw provider credential, and under trust model A it cannot reach the
   owner's (11 §3; FR-SEC).
2. No production mutation happens through any channel unless a protected execution identity runs at
   a commit and artifact carrying a valid owner-signed approval (18 §3, §5). The exception is tools
   whose policy is `auto-on-green`, which the schema limits to low-stakes cells (ADR-07) and which
   the owner enabled through a signed policy change (18 §7).
3. No agent identity is the owner's identity, and no agent identity holds `workflows`, `secrets`,
   `administration`, `environments`, `actions: write` or `deployments: write` (18 §2).
4. No text from outside the owner's control becomes skill text without the gate and a human merge
   (06; ADR-01, ADR-11).
5. No page from outside the owner's control is surfaced to a building agent unless it is
   `confirmed` (04 §4).
6. Every capture point redacts, and the redaction test is a merge blocker (11 §6; 13).
7. Every gate has a demonstration that it fails: graders against mutants, proxy policy against its
   mutation set, and release authority against acceptance tests A-01 to A-15 with A-16 as the
   positive control (06 §4.3; 11 §4.2; 18 §9).
8. Recovery deploys only previously approved immutable artifacts (18 §6).

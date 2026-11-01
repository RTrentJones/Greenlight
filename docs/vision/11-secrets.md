# 11 — Secrets

## 1. Model: one readable source, three consumers

Today GitHub Actions secrets are the single store (`docs/security.md`). `secrets gather`
hidden-prompts for each value, verifies it fail-fast and pushes it with `gh secret set`, with the
value on stdin. Terraform then projects the provider credentials into the runtime stores. This is
sound for CI. Its structural limit is that **Actions secrets are write-only from outside a
workflow**, so an agent step that needs a credential has no sanctioned source. Steps like this
include `verify --env prod` with `BAMCP_VERIFY_TOKEN`, `accounts` running `verify()`, a deploy from
a session, and a provider MCP server. The workaround today is a pasted token.

This pack replaces the single write-only store with **one readable source and three consumers**:

```
                         ┌──────── source of truth (Infisical | GitHub-only fallback) ────────┐
                         │                       │                                             │
            sync ▼                     Terraform ▼                              proxy ▼
      GitHub Actions secrets      Workers secrets / Vercel env           agent sessions: placeholders only;
      (CI: infra/deploy/promote)  (runtime; unchanged)                   real values injected on the wire
```

| consumer | gets | how | changes from today |
|---|---|---|---|
| CI | real values | `secrets.*` in workflows | none to workflows; the values are written by the sync instead of `gh` |
| runtime | real values | Terraform variables → provider stores | none |
| agents | **placeholders** | credential proxy (§3) | new |

The **sink** is chosen once per wrapper (`secrets.sink` in the manifest; 07 §2.1):

- `infisical` is the default from P4 on (ADR-06).
- `github` is today's model. It remains supported for owners who want no new account. In that mode
  agents get no credentials at all, and every authenticated step runs in CI. The skills say so.

## 2. Infisical as the source (sink `infisical`)

### 2.1 Why Infisical

Of the options surveyed (16, ADR-06), Infisical fits on four counts:

- it is open source and self-hostable, which suits clone-and-own;
- it has a hosted free tier;
- it ships both a credential-injecting proxy (Agent Proxy) and an open-source forward proxy
  (Agent Vault);
- it syncs secrets *to* GitHub Actions, so CI is untouched.

Whether Agent Proxy is included in the hosted free tier was not confirmed when this was written.
P4 MUST confirm it, and if it is not included, the default proxy becomes the Worker proxy (§3.2).

### 2.2 Layout

The manifest field:

```ts
secrets: {
  sink: 'infisical' | 'github';
  infisical?: { domain?: string /* self-host / EU */; projectId: string; environment: 'prod' };
  proxy?: 'infisical' | 'worker' | 'none';
}
```

`projectId` is an enumerable identifier, not a secret, following the existing "IDs are not
secrets" rule. Secrets live at the path `/<scope>/<ENV_VAR>`, where `scope` is `shared` for
always-on provider tokens or the tool name for per-tool tokens. The GitHub secret names stay the
manifest's existing names, such as `TF_VAR_HEISTMIND_DISCORD_CLIENT_SECRET`, so no workflow
changes.

### 2.3 Sync to GitHub

`init --sink infisical` and `secrets gather` configure an Infisical **secret sync** to the wrapper
repo's Actions secrets, and to each tool repo for per-repo tokens such as
`GREENLIGHT_DISPATCH_TOKEN`. `secrets check` reports any secret that is present in Infisical but
missing from GitHub as `present but not synced`, and it exits 1 under `--strict`.

### 2.4 CI authentication

CI does not authenticate to Infisical, because it reads the synced GitHub secrets. Infisical
itself authenticates to GitHub using the GitHub App installation that the sync requires. No
long-lived Infisical token is stored in GitHub.

## 3. The agent credential proxy

### 3.1 Principle

An agent process never holds a raw credential. Its environment carries placeholders of the form
`gl-placeholder-<ENV_VAR>`. A proxy outside the agent's process matches each outbound request
against an allow-list and replaces the placeholder or authorization header with the real value. A
compromised or manipulated agent therefore has no secret it could leak (12 T-01, T-02).

This is not what Codex cloud does. Codex cloud makes secrets available only to the setup script
and removes them before the agent phase, while plain environment variables persist (OpenAI,
"Cloud environments"). That keeps secrets away from the agent, but it also means the agent cannot
make an authenticated call during its work. The proxy pattern covers the working phase. The same
pattern is used by Docker's AI sandboxes, Infisical's Agent Proxy and Agent Vault, and the egress
proxy of this project's own cloud sessions. Section 7 covers how Codex fits (P7).

### 3.2 Two implementations

| | Infisical Agent Proxy (forward) | Worker proxy (reverse) |
|---|---|---|
| shape | HTTPS forward proxy; `HTTPS_PROXY` points at it; it terminates TLS for allow-listed hosts | a Cloudflare Worker at `vault.<domain>` (or `vault.<sub>.workers.dev`); clients call `https://vault…/<provider>/<path>` |
| transparency | transparent to clients that honour `HTTPS_PROXY` | each client needs a base-URL override |
| TLS | the agent must trust the proxy CA (`NODE_EXTRA_CA_CERTS`); the CA can see **all** proxied traffic (12 T-09) | ordinary TLS to the Worker; no CA installed |
| hosting | Infisical (hosted or self-hosted) | the owner's Cloudflare account (free tier); secrets in Workers secrets, projected by Terraform |
| launch | `infisical secrets agent-proxy connect`, wrapped by `greenlight agent run` | `greenlight agent run --proxy worker` sets the base-URL overrides |
| code we own | none | the Worker (≈ 200 lines), a security-critical surface (12 T-09) |

The base-URL overrides used by the Worker proxy are emitted per provider pack as `baseUrlEnv`. A
pack whose client cannot be redirected cannot use the Worker proxy, and its token stays CI-only
under that proxy. `proxy-config --check` reports these cases.

**Node.** Node 24's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set.
Greenlight pins Node 24, so `agent run` sets the variable and DR-31 checks it.

### 3.3 Sessions

`greenlight agent run` (07 §2.12) creates one proxy session per agent process.

- **Identity.** A session id (`gs_<random>`), the operator's GitHub login, the agent vendor and
  model, and the wrapper repo.
- **Lifetime.** The TTL defaults to 8h and is capped at 24h. The session is revoked when the child
  exits.
- **Credential.** The proxy session credential is a short-lived token that the proxy issues. For
  Infisical this is a machine identity with the built-in Agent Proxy role. For the Worker proxy it
  is an HMAC-signed bearer that only the Worker can verify. The session credential is the *only*
  real secret the agent holds, and it is useless outside the proxy.
- **Audit.** For each request the proxy logs `(sessionId, host, method, path, status, injected:
  bool, denied: bool)`, with no bodies. The log is retained for 30 days. `wiki capture` can attach
  a session's audit summary to a raw record (`refs: session:<id>`), so credential use joins the
  `(tool, sha)` evidence trail (03 §5).

### 3.4 Promotion approval

Release stays human (ADR-07). This holds as a mechanism even for an agent that has GitHub access:

- The session's GitHub route **denies**
  `POST /repos/{o}/{r}/actions/workflows/promote.yml/dispatches`, together with the equivalent
  `gh workflow run promote.yml`, unless the session was started with `--allow-promote`. That flag
  requires an interactive confirmation on the operator's TTY.
- `greenlight promote --perform` outside CI requires `--approval <token>` (07 §2.7). The token is
  an approval record in the format given in §4.4.
- Inside `promote.yml`, approval is the `workflow_dispatch` by a human actor, which is the
  existing behavior.

DR-32 fails when the rendered proxy allow-list would permit the dispatch without approval.

### 3.5 Bench sandboxes

Bench rollouts (06 §4) run behind the same proxy implementation in a **fake-upstream** mode. The
allow-listed hosts resolve to local stubs that record the requests and return canned responses
from the task's `fixture/`. No real credential exists in a bench sandbox. The rollout code path is
identical to production, so a proxy-related failure shows up in the bench first.

## 4. Proxy configuration

`greenlight secrets proxy-config` (07 §2.13) renders the union of `inject` specs (08 §12) for
every **configured** token in the manifest's tool set.

### 4.1 Rendering rules

1. Hosts are exact. A leading `*.` matches exactly one label. No other wildcards are allowed.
2. `allow` is default-deny. A request is forwarded only if `(method, path)` matches an entry.
   Unmatched requests to an allow-listed host get `403 {"error":"denied by greenlight proxy",
   "rule":"<host>"}` and are logged with `denied: true`.
3. Injection replaces the `header` with `<scheme> <value>`, or the raw value, after removing any
   value the agent sent. The agent cannot pass a second credential through.
4. The output is deterministic, with sorted keys, so `--check` can diff it.

### 4.2 Seed `inject` entries

The seed `inject` entries are below. The paths are deliberately narrower than each token's scopes,
so that the proxy enforces less than the token permits.

| token (`envVar`) | hosts | allow (summary) | denied of note |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `api.cloudflare.com` | `GET /client/v4/**`; `PUT /client/v4/accounts/*/workers/scripts/*`; `POST /client/v4/graphql` | DNS record deletes, zone settings |
| `VERCEL_API_TOKEN` | `api.vercel.com` | `GET /**`; deployment create/promote for the wrapper's project ids only | project/domain deletes |
| `NEON_API_KEY` | `console.neon.tech` | `GET /api/v2/**`; branch create/delete only for non-default branches | project delete |
| `SUPABASE_ACCESS_TOKEN` | `api.supabase.com` | `GET /v1/**` | everything mutating; migrations go through CI's gate |
| `GEMINI_API_KEY` | `generativelanguage.googleapis.com` | `POST /v1beta/models/*:generateContent` | — (header `x-goog-api-key`, scheme `raw`) |
| `TF_API_TOKEN` | `app.terraform.io` | `GET /api/v2/**` | state writes, runs (apply is CI-only) |
| `GITHUB_TOKEN` | `api.github.com` | `GET /**`; issue/PR create and comment on the wrapper and tool repos | `promote.yml` dispatch (§3.4); secrets endpoints; branch protection |
| per-tool verify tokens, e.g. `BAMCP_VERIFY_TOKEN` | the tool's prod host | `POST /mcp` | — |

### 4.3 CI-only tokens

**CI-only tokens** have no `inject` field, and DR-30 lists them:

- `TF_VAR_oci_private_key` and the other OCI auth values. OCI authenticates with API-key request
  signing over the request itself, and a header swap cannot produce the signature.
- `DOCKER_SSH_*`. SSH is not HTTP.
- `GREENLIGHT_DISPATCH_TOKEN` and `GREENLIGHT_STATUS_TOKEN_<TOOL>`. These are cross-repo workflow
  plumbing and have no agent use case.
- Database passwords (`TF_VAR_*_DATABASE_PASSWORD`). Agents use the read paths above, and DDL goes
  through CI's migrations gate.

### 4.4 Promotion approval record

**How the owner approves.** There are two equivalent paths, and both require a human at a TTY or
in the GitHub UI.

1. **In GitHub.** The owner dispatches `promote.yml` with the `name` input, as today. The approval
   *is* the `workflow_dispatch` event. Its actor, captured as `github.actor`, must be a user and not
   a bot. No record is minted, because the workflow pins the sha itself (capture develop's tip, then
   `verify --expect-sha`, then `promote --commit`).
2. **In a shell.** The owner runs `greenlight promote <tool> --commit <sha> --approve`. This prints
   the record's summary and asks for typed confirmation of the short sha. It refuses when stdin is
   not a TTY, so an agent cannot complete it. It then mints the record and prints it once as a
   compact token.

**Record format.** The record is a JSON object, signed and then encoded as
`gla1.<base64url(payload)>.<base64url(sig)>`:

```ts
interface PromotionApproval {
  v: 1;
  tool: string;                // manifest name
  sha: string;                 // 40-hex: the exact develop commit approved for main
  repo: string;                // "<owner>/<repo>" whose develop→main FF is approved (the tool repo for cross-repo tools)
  approver: string;            // GitHub login of the human (from `gh api user` at mint time)
  issuedAt: string;            // ISO
  expiresAt: string;           // ISO, issuedAt + ≤ 1h
  nonce: string;               // 16 random bytes, hex; single use
}
```

`sig` is HMAC-SHA256 over the payload bytes, keyed by `GREENLIGHT_APPROVAL_KEY`. That key lives
in the secret source and is **CI-only toward agents**: it has no `inject` entry, so an agent can
never sign a record. It is available to the operator's shell (for minting), to the proxy (for
checking), and to CI.

**How it is checked.** The proxy and the CLI check a record in the same way.

1. When the proxy sees a request to dispatch `promote.yml`, or a
   `PATCH /repos/{o}/{r}/git/refs/heads/main` from a session, it requires the header
   `X-Greenlight-Approval: <token>`. `greenlight promote --approval` sets that header on its GitHub
   calls.
2. It verifies the signature, checks that `expiresAt` is in the future, and checks that the
   `nonce` has not been used. Used nonces are kept in the proxy's store until expiry.
3. It checks that the request targets `repo`. For a dispatch, the `inputs.name` must equal `tool`.
   For a ref update, the new `sha` must equal the record's `sha`. For a dispatch, the record's `sha`
   is passed as the `commit` input, and `promote.yml` verifies that develop's tip equals it before
   anything else. The existing `promote --commit` refusal (develop moved) covers the race.
4. On success it forwards the request and marks the nonce used. On failure it returns
   `403 {"error":"promotion requires a valid approval","reason":"<expired|sha-mismatch|tool-mismatch|replayed|bad-signature>"}`.

`greenlight promote --perform --approval <token>` outside CI applies the same checks locally before
it attempts the fast-forward. It writes the approval's `approver` and `nonce` into the `promote`
stage event's `detail`, so the raw record shows who approved which sha.

## 5. Limits and response scrubbing

- **A proxy prevents leaks, not misuse.** An agent behind the proxy can still make every allowed
  call. Least-privilege tokens (`docs/tokens-reference.md`) remain the first control and
  allow-lists the second. Every allow-list ships with a **mutation check**: `proxy-config --check`
  replays a fixed set of forbidden requests per host against the rendered rules and fails if any
  would be forwarded. This applies the "graders must be shown to fail" rule (06 §4.3) to the proxy.
- **Responses can carry secrets back.** Some provider APIs return secrets in normal responses:
  Neon connection URIs with passwords, Supabase API keys and service-role keys, and Vercel
  environment-variable values with `decrypt=true`. Each `inject` entry MAY list `scrub` rules (JSON
  paths or regexes). The proxy applies these and the §6 detector to response bodies before
  returning them, and replaces any match with `gl-redacted-<kind>`. The scrubbed form is what the
  agent sees and what any trace captures.
- **TLS interception is a trust decision.** Installing the forward proxy's CA lets it read all
  traffic that goes through it. `agent run` routes only allow-listed hosts through the proxy
  (`NO_PROXY` for everything else) when the proxy supports split routing. The skills state the
  trade-off when offering `--proxy infisical`.
- **Placeholders are not secrets.** `gl-placeholder-*` values may appear in logs and traces. The
  §6 detector ignores them.

## 6. Redaction detector

A single implementation, `packages/shared/src/redact.ts`, is used by raw capture (07 §3.5),
`wiki ingest` bundles, proxy response scrubbing, LR-20, and `wiki contribute`. It finds secrets in
two ways.

1. **By value.** In any process that has access to real values (CI, an operator shell), every
   value of every token name in the manifest's tool set and the provider packs, if it is 8
   characters or longer, is matched literally. Its URL-encoded and base64 forms are matched too.
   This catches secrets with no recognizable shape.
2. **By shape** (always on):

| kind | pattern (illustrative; implement as tested regexes) |
|---|---|
| github | `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{60,}` |
| cloudflare | 40-character token following `Bearer ` in a header dump; `CF-*` keys in `key=value` form |
| vercel | 24-character alphanumeric following `Bearer ` (Vercel tokens have no fixed prefix), plus key-name context (`VERCEL_*TOKEN=`) |
| neon | `napi_[A-Za-z0-9]{40,}`; `postgres(ql)?://[^:]+:[^@]+@` → the password segment |
| supabase | JWT shape `eyJ[\w-]+\.[\w-]+\.[\w-]+`; `sbp_[A-Za-z0-9]{40}` |
| google | `AIza[0-9A-Za-z_-]{35}` |
| anthropic | `sk-ant-[A-Za-z0-9_-]{20,}` |
| xai/openai-style | `xai-[A-Za-z0-9]{20,}`, `sk-[A-Za-z0-9]{32,}` |
| private keys | `-----BEGIN [A-Z ]*PRIVATE KEY-----` … `-----END …-----` |
| hcp | `[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9]{60,}` |
| generic | `(?i)(secret|token|password|api[_-]?key)\s*[:=]\s*\S{8,}` → the value part |

Each match is replaced with `gl-redacted-<kind>`. The detector MUST have a test that plants one
example of every shape, plus every manifest secret name with a random value, into a sample log, and
asserts zero survivors. This is the P5 merge blocker (14). The shapes are illustrative and MUST be
confirmed against each provider's documented token format when they are implemented.

## 7. Codex (P7)

Codex cloud removes secrets before the agent phase, so a Codex cloud task cannot run authenticated
steps itself. The P7 options, in order of preference, are:

1. rely on CI's `ship` and `promote.yml` for every authenticated step, which needs no new
   mechanism;
2. run Codex locally under `greenlight agent run -- codex`, which works today for the CLI, given
   that it honours `HTTPS_PROXY`. Codex CLI proxy behavior MUST be verified at P7;
3. a Codex cloud environment whose setup script starts the proxy's client side and whose agent
   phase reaches the proxy over the network. This depends on Codex cloud network policy and is
   unverified.

The skills MUST tell a Codex cloud agent which of these applies, and they MUST NOT suggest writing
a secret into a file during setup. A file written during setup survives into the agent phase and
defeats the boundary.

## 8. Sources

- OpenAI, Codex cloud environments: https://developers.openai.com/codex/cloud/environments
- Infisical Agent Proxy overview: https://infisical.com/docs/documentation/platform/agent-proxy/overview
- Infisical Agent Proxy quickstart: https://infisical.com/docs/documentation/platform/agent-proxy/quickstart
- Infisical Agent Vault: https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents
- Docker sandboxes, credentials: https://docs.docker.com/ai/sandboxes/security/credentials/
- Blaxel, egress proxy for agent credentials: https://blaxel.ai/blog/egress-proxy-api-credentials-ai-agent-sandboxes

Vendor details are as of November 2026, and several of these products are months old. P4 MUST
re-verify them.

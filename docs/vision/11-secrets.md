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

- `infisical` is the default from M5 on (ADR-06), subject to the availability check in §2.1.
- `github` is today's model. It remains supported for owners who want no new account. In that mode
  agents get no credentials at all, and every authenticated step runs in CI. The skills say so.

### 1.1 Trust models

What a proxy guarantees depends on where the agent runs. Two trust models are supported, and the
documents and skills name which one applies.

| | **A — isolated agent** | **B — local convenience** |
|---|---|---|
| where the agent runs | a separate container, VM, cloud session, or OS user with its own home directory | the operator's own shell, under `greenlight agent run --local` |
| what it cannot reach | operator credentials and key files (`~/.ssh`, `~/.config/gh`, cloud CLI configs), credential helpers (git credential manager, `gh auth git-credential`, OS keychain), agent sockets (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`), the Docker socket, the parent process's environment and file descriptors, the release signing key (18 §3.1) | nothing is enforced. Environment variables are replaced, and that is all |
| network | **enforced egress**: a firewall or network policy allows only the proxy and package registries. The proxy is the only route to provider hosts | routing only. `HTTPS_PROXY` is a setting the agent's tools may ignore, and direct connections succeed |
| guarantee | an agent, even a manipulated one, cannot read a planted operator credential, inherit a credential helper, mint an approval, or reach a provider by a route around the proxy | prevents **accidental** leakage, such as a token printed into a transcript or copied into a file. It is **not** a boundary against an agent that sets out to find credentials |
| use | default for bench sandboxes (§3.5) and cloud sessions; required for any claim in 12 that depends on the proxy | a single operator's local work, where the operator accepts the residual risk |

**Allocating a pseudoterminal is not proof of human presence.** An agent with shell access can
allocate a PTY, and refusing non-TTY stdin is only an interaction safeguard. Earlier drafts used a
TTY check as an approval mechanism, and this document no longer does. Approval is the signed
release artifact in 18 §3.1, made with a key the agent cannot reach under model A. Under model B
the key MUST be held where the shell cannot use it without a human action, such as a hardware key
that requires touch. The documentation states that model B gives no stronger guarantee.

## 2. Infisical as the source (sink `infisical`)

### 2.1 Why Infisical

Of the options surveyed (16, ADR-06), Infisical fits on four counts:

- it is open source and self-hostable, which suits clone-and-own;
- it has a hosted free tier;
- it ships both a credential-injecting proxy (Agent Proxy) and an open-source forward proxy
  (Agent Vault);
- it syncs secrets *to* GitHub Actions, so CI is untouched.

Whether Agent Proxy is included in the hosted free tier was not confirmed when this was written,
and both Infisical proxy products are recent. The product claims in this section are **to verify**.
M5 does not commit to a general implementation up front. It first prototypes **one** credential
integration end to end:
- the Cloudflare beta-account token through the chosen proxy;
- under trust model A (§1.1);
- with the client compatibility tests in §4.6.

The default proxy is chosen from that evidence. If Agent Proxy is unavailable or fails the tests,
the Worker proxy is evaluated next, against the same tests.

### 2.2 Layout

The manifest field:

```ts
secrets: {
  sink: 'infisical' | 'github';
  infisical?: { domain?: string /* self-host / EU */; projectId: string; environment: 'prod' };
  proxy?: 'infisical' | 'worker' | 'none';
  trustModel?: 'A' | 'B';   // declared trust model (§1.1); default 'A' where an isolated runner exists
}
```

The normative schema is `SecretsSettings` in 08 §13.

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
against an allow-list and replaces the placeholder or authorization header with the real value. Under
trust model A, a compromised or manipulated agent therefore has no secret it could leak (12 T-01,
T-02). Under model B, the same holds only for agents that do not go looking.

This is not what Codex cloud does. Codex cloud makes secrets available only to the setup script
and removes them before the agent phase, while plain environment variables persist (OpenAI,
"Cloud environments"). That keeps secrets away from the agent, but it also means the agent cannot
make an authenticated call during its work. The proxy pattern covers the working phase. The same
pattern is used by Docker's AI sandboxes, Infisical's Agent Proxy and Agent Vault, and the egress
proxy of this project's own cloud sessions. Section 7 covers how Codex fits (M7).

### 3.2 Two implementations

| | Infisical Agent Proxy (forward) | Worker proxy (reverse) |
|---|---|---|
| shape | HTTPS forward proxy; `HTTPS_PROXY` points at it; it terminates TLS for allow-listed hosts | a Cloudflare Worker at `vault.<domain>` (or `vault.<sub>.workers.dev`); clients call `https://vault…/<provider>/<path>` |
| transparency | transparent to clients that honour `HTTPS_PROXY` | each client needs a base-URL override |
| TLS | the agent must trust the proxy CA (`NODE_EXTRA_CA_CERTS`); the CA can see **all** proxied traffic (12 T-09) | ordinary TLS to the Worker; no CA installed |
| hosting | Infisical (hosted or self-hosted) | the owner's Cloudflare account (free tier); secrets in Workers secrets, projected by Terraform |
| launch | `infisical secrets agent-proxy connect`, wrapped by `greenlight agent run` | `greenlight agent run --proxy worker` sets the base-URL overrides |
| code we own | none | the Worker (≈ 200 lines), a security-critical surface (12 T-09) |

The base-URL overrides used by the Worker proxy are declared per credential as `baseUrlEnv` in the
policy (§4.2, 08 §12). A client that cannot be redirected cannot use the Worker proxy, and its
token stays CI-only under that proxy. The client support matrix (§4.6) records these cases, and
`proxy-config --check` reports them.

**Split routing.** With the forward proxy, `agent run` sends only allow-listed hosts through it,
and sets `NO_PROXY` for everything else, to limit what the proxy's CA can see (§5). Under model A
the firewall still blocks direct egress to provider hosts, so split routing narrows TLS
interception without opening a bypass. Under model B split routing is a convenience only. 12 states
its controls accordingly.

**Node.** Node 24's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set.
Greenlight pins Node 24, so `agent run` sets the variable and DR-31 checks it.

### 3.3 Sessions and grants

`greenlight agent run` (07 §2.12) creates one proxy session per agent process, in model A
(`--isolated`) or model B (`--local`).

- **Identity.** A session id (`gs_<random>`), the **agent identity** (18 §2, never the owner's
  login), the agent vendor and model, the wrapper repo, and the trust model (`A` or `B`).
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

Release authority is defined in [18](18-release-authority.md). The proxy supports it as defense in
depth. It is **not** where approval is enforced, because the proxy cannot see a provider deploy
that a production job makes, and under model B it can be bypassed.

- **Agents hold no production credential**, so the proxy carries none (18 §4). A production
  mutation cannot be made through the proxy at all.
- **The GitHub route denies**, for every session:
  - every `POST /repos/*/*/actions/workflows/*/dispatches`, by file name or numeric id;
  - `POST /repos/*/*/dispatches`;
  - ref writes to `refs/tags/release/*` and to the Vercel production branch, through the REST git
    refs API, the contents API and the GraphQL `createRef`/`updateRef` mutations. The proxy
    matches GraphQL by parsing the operation (§4.1).
- **Approval itself is a signed release tag** (18 §3.1), verified by the production job.

DR-32 fails when the rendered policy would forward any of the denied operations.

### 3.5 Bench sandboxes

Bench rollouts (06 §4) run under trust model A, behind the same proxy implementation in a
**fake-upstream** mode. The
allow-listed hosts resolve to local stubs that record the requests and return canned responses
from the task's `fixture/`. No real credential exists in a bench sandbox. The rollout code path is
identical to production, so a proxy-related failure shows up in the bench first.

## 4. Proxy configuration

`greenlight secrets proxy-config` (07 §2.13) renders a **policy** from the `inject` specs (08 §12)
of every configured token. Earlier drafts allowed only host, method and path globs. That language
could not express the seed rules ("only the wrapper's projects", "only non-default branches"), so
it is replaced by the typed policy below.

### 4.1 Request normalization

Before any rule is evaluated, the proxy normalizes the request:

1. **Path canonicalization.** Percent-decode once, collapse `//`, resolve `.` and `..`, and reject
   requests whose decoded path contains `..`, a NUL byte, or a second encoding layer.
2. **Size.** Reject request bodies larger than `maxBodyBytes` (default 1 MiB) with 413. Bodies that
   rules inspect must be fully read first, so streaming uploads are refused on routes that have
   body predicates.
3. **Parsing.** Parse the query string and, for `application/json`, the body. GraphQL requests are
   parsed into operation type, field names and variables, so rules can match `mutation updateRef`.
   An unparseable body on a route with body predicates is denied.
4. **Credential stripping.** Strip every header named in the credential's `inject.header`, and any
   `Authorization`, `Cookie` or `X-*-Key` header the agent sent.

### 4.2 Policy language

```ts
interface ProxyPolicy {
  version: 1;
  credentials: CredentialRule[];
  defaults: { maxBodyBytes: number; followRedirects: false; auditBodies: false };
}

interface CredentialRule {
  id: string;                         // "cloudflare-beta", "github-agent"
  secret: string;                     // envVar in the secret source
  env: 'beta' | 'any';                // production credentials never render for agent sessions (18 §2)
  hosts: string[];                    // exact; leading "*." matches one label
  inject: { header: string; scheme: 'Bearer' | 'Basic' | 'raw' }
        | { placeholder: string; in: 'path' | 'query' | 'header' | 'body' };   // substitution
  baseUrlEnv?: string;                // Worker proxy: env var the client reads for its API base URL
  select: Selector;                   // which requests this credential is FOR (credential selection)
  allow: Rule[];                      // default deny
  deny?: Rule[];                      // evaluated first; wins over allow
  scrub?: string[];                   // response JSON paths / regexes (§5)
}

interface Rule {
  method: string | string[];
  path: string;                       // glob over the canonical path; ":name" captures a segment
  query?: Predicate[];
  body?: Predicate[];                 // JSON pointer predicates, or GraphQL operation predicates
  resource?: ResourceSelector;        // ties a captured segment or body value to an allowed set
}

type Predicate =
  | { at: string; equals: string | number | boolean }
  | { at: string; in: (string | number)[] }
  | { at: string; matches: string }   // anchored regex
  | { at: string; absent: true }
  | { graphql: { type: 'query' | 'mutation'; fields: string[] } };

interface ResourceSelector {
  from: string;                       // ":acct", ":script", "/body/project_id", …
  allowed: string[] | { manifest: 'beta-scripts' | 'wrapper-repos' | 'beta-account' | 'tool-beta-hosts' };
}

type Selector = { always: true } | { resource: ResourceSelector } | { header: string; equals: string };
```

**Evaluation order.**

1. **Select the credential.** Among the rules whose `hosts` match, exactly one `select` must match.
   - If none matches, the request is denied.
   - Two rules for one host with overlapping selectors fail at `proxy-config` time.

   This removes any union of permissions across two credentials for the same host, so two tool
   credentials on one host cannot cross scopes.
2. **Apply the rules.** Evaluate `deny`, then `allow`, against the canonical request.
3. **Resolve resources.** Resolve `resource` selectors against the manifest when the session
   starts. The resolved sets are frozen for the session.
4. **Inject** the credential.
5. **Forward** with redirects **not** followed. A 3xx response is returned to the client with its
   `Location` header. If the client follows it to a host that is not allow-listed, the request
   carries no credential, and under model A it cannot leave the sandbox.

`proxy-config --check` also runs a **mutation set** for each credential. This is a fixed list of
forbidden requests, and the check fails if any of them would be forwarded (§5):
- another account id;
- a production script name;
- a `release/*` tag ref;
- a dispatch by numeric workflow id;
- a GraphQL `createRef` mutation;
- a path containing an encoded `..`;
- a body that names a disallowed project;
- a request matching two credentials.

### 4.3 Seed rules

The seed rules are deliberately narrower than each token's scopes.

| credential | hosts | allow (summary) | deny of note |
|---|---|---|---|
| `cloudflare-beta` (beta account token, 18 §4) | `api.cloudflare.com` | `GET /client/v4/accounts/:acct/**` with `:acct` ∈ `beta-account`; `PUT /client/v4/accounts/:acct/workers/scripts/:script` with `:script` ∈ `beta-scripts`; `POST /client/v4/graphql` with `type: query` | every other account id; zones and DNS; user-level token endpoints |
| `github-agent` (agent identity token) | `api.github.com` | `GET /**`; issue and PR create, comment and update on `wrapper-repos`; `POST /repos/:o/:r/git/refs` with `/body/ref` not matching `^refs/tags/release/` | every workflow dispatch, by name or numeric id; `POST /repos/*/*/dispatches`; secrets, environments, deployments, branch protection and rulesets endpoints; GraphQL `createRef`/`updateRef` whose ref matches `refs/tags/release/` or the Vercel production branch |
| `gemini` | `generativelanguage.googleapis.com` | `POST /v1beta/models/*:generateContent` | — (header `x-goog-api-key`, scheme `raw`) |
| `tf-read` | `app.terraform.io` | `GET /api/v2/**` | runs, state writes |
| per-tool verify tokens (beta) | the tool's beta host (`tool-beta-hosts`) | `POST /mcp`, `GET /**` | — |

Agents receive the Neon **beta branch connection string** as an environment value, not an API
key. There is no agent rule for Vercel, Supabase, the Neon API, or any production host. Production
verification with a token runs in CI's `ship`.

### 4.4 CI-only tokens

**CI-only tokens** have no `inject` field, and DR-30 lists them:

- `TF_VAR_oci_private_key` and the other OCI auth values. OCI authenticates with API-key request
  signing over the request itself, and a header swap cannot produce the signature.
- `DOCKER_SSH_*`. SSH is not HTTP.
- `GREENLIGHT_DISPATCH_TOKEN` and `GREENLIGHT_STATUS_TOKEN_<TOOL>`. These are cross-repo workflow
  plumbing.
- Database passwords (`TF_VAR_*_DATABASE_PASSWORD`). DDL goes through CI's migrations gate.
- **Every production credential** (18 §2). These are the production Cloudflare account token,
  `VERCEL_API_TOKEN`, `NEON_API_KEY`, `SUPABASE_ACCESS_TOKEN` and `TF_API_TOKEN` with apply rights.
- `GREENLIGHT_RELEASE_SIGNERS`. This is not a credential, but it is the trust root for approvals
  (18 §3.1), so it is CI-only.

There is no `GREENLIGHT_APPROVAL_KEY`. Earlier drafts minted approvals with a shared HMAC key, and
that approach is withdrawn, because any process that could reach the key could approve.

### 4.5 Approval replay and audit

- **Replay protection** for approvals is a property of the production job (18 §3.1 step 5). The
  proxy holds no approval state.
- **Audit records** hold `(sessionId, credentialId, host, method, canonicalPath, status, injected,
  denied, ruleId)`. Query strings, bodies and headers are never logged. Path segments that no
  `resource` selector names are hashed before logging, because a path can carry a secret.

### 4.6 Client support matrix

A credential is offered to agents only through clients that have been shown to work with the
chosen proxy implementation. The others are reported by `proxy-config --check` as **CI-only for
this implementation**. The M5 prototype fills in this matrix. The entries below are the expected
starting points to test, and none of them is a claim.

| client | forward proxy (`HTTPS_PROXY` + CA) | Worker proxy (base-URL override) | test |
|---|---|---|---|
| `wrangler` | expected to work, with `NODE_EXTRA_CA_CERTS` | to verify: whether it honours an API base-URL override | `wrangler deploy` of a beta script; the same against a production script name, which must be refused |
| `gh` | expected to work (`HTTPS_PROXY`, custom CA) | `GH_HOST` targets GitHub Enterprise hosts, which is not a general override; treat as unsupported | `gh pr create`; `gh api` on an allowed and a denied path; `gh workflow run` by numeric id, which must be refused |
| `git` over HTTPS | expected to work (`http.proxy`, `http.sslCAInfo`) | unsupported | push to an allowed branch; push of a `release/*` tag, which must be refused |
| Terraform providers | expected to work (Go honours `HTTPS_PROXY`) | per provider, to verify | `terraform plan` with the read-only token |
| `vercel` CLI, Neon and Supabase CLIs | n/a: agents hold no credential for them | n/a | none |
| Node `fetch` (Node 24) | only with `NODE_USE_ENV_PROXY=1` and the CA (DR-31) | works with an explicit base URL | the verify harness against a beta MCP endpoint |

Each test runs in a model-A sandbox with direct egress blocked. A client that bypasses the proxy
therefore fails instead of passing silently.

### 4.7 Promotion approval record (moved)

The approval record that earlier drafts defined at §4.4 has been replaced by the owner-signed
release tag in [18 §3.1](18-release-authority.md). References to "11 §4.4" for approval mean 18
§3.1.

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
  traffic that goes through it. Split routing (§3.2) limits that to allow-listed hosts. Under model
  A the firewall still prevents direct egress, so this narrows the CA's view without creating a
  bypass. The skills state the trade-off when offering `--proxy infisical`.
- **Streaming responses** are scrubbed incrementally with a carry-over buffer of 4 KiB, so a secret
  split across chunks is still matched. Responses with a `Content-Encoding` are decoded before
  scrubbing and re-encoded after.
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
| url-password | `<scheme>://[user]:<password>@` for any scheme other than postgres (`mysql://`, `redis://` and `rediss://`, including the empty-user `redis://:pw@` form, `mongodb+srv://`, `amqp://`, `https://`) → the password segment |
| basic-auth | `Basic <base64>` whose decoded value is printable `user:password` → the base64 part |
| generic | `(?i)(secret|token|passw(or)?d|api[_-]?key)([_-]?key)?["']?\s*[:=]\s*\S{8,}` → the value part. There is **no word boundary before the key name**, so `GITHUB_TOKEN=`, `DB_PASSWORD=`, `PGPASSWORD=`, `MY_API_KEY=`, `ACCESS_TOKEN:` and `client_secret:` all match |

Each match is replaced with `gl-redacted-<kind>`.

**Values that are not values.** The key-context shapes (generic, cloudflare and vercel) skip a
value that names a secret instead of holding one:

- a placeholder or reference: `$VAR`, `${{ secrets.X }}`, `<token>`, `%TOKEN%`, an interpolation
  such as `var.${name}_token`, `gl-placeholder-*`, or a value containing `placeholder`;
- an env-var name, such as `token: 'SUPABASE_ACCESS_TOKEN'`;
- an **unquoted code expression**: a member access or index (`apikey: t.anonKey,`,
  `m[group]`), a function call (`token: getToken()`), or a bare identifier followed by a code
  terminator (`password: dbPassword,`).

A quoted value is always a literal, so `apikey: 'literal-anon-key'` is flagged. A bare word with
nothing after it, such as an env file's `DB_PASSWORD=` followed by one word, is also flagged. This
keeps vendored source that passes a credential along from reading as a leak. For example, the
keepalive worker's `headers = { apikey: t.anonKey, … }` is not flagged. A test asserts that every
file under `bench/fixtures/` and `bench/tasks/*/fixture/` scans clean. The detector MUST have a test that plants one
example of every shape, plus every manifest secret name with a random value, into a sample log, and
asserts zero survivors. This is a merge blocker for raw capture in M3 (14). The shapes are illustrative and MUST be
confirmed against each provider's documented token format when they are implemented.

## 7. Codex (M7)

Codex cloud removes secrets before the agent phase, so a Codex cloud task cannot run authenticated
steps itself. For this purpose Codex cloud is a trust model A environment. The M7 options, in order
of preference, are:

1. rely on CI's `ship` and `promote.yml` for every authenticated step, which needs no new
   mechanism;
2. run Codex under `greenlight agent run -- codex`, isolated (model A) where possible, given that
   the Codex CLI honours `HTTPS_PROXY`. Its proxy behavior MUST be verified at M7 and added to
   §4.6;
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

Vendor details are as of November 2026, and several of these products are months old. M5 MUST
re-verify them before choosing an implementation.

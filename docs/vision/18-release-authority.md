# 18 — Release authority

## 1. Purpose and principle

The vision states that the owner controls release. Earlier drafts enforced that only at
`promote.yml` dispatch, which leaves production reachable by other routes:

- a provider deploy API;
- a push that triggers a direct-to-prod workflow;
- a `repository_dispatch`;
- a recovery job;
- an edit to the policy itself.

This document defines release authority over **every** path that can change production. It
answers the review's first finding (14 M5 is where it is built). The deployment-related work in
other milestones is blocked on the gaps in §8.

**Principle.** Production changes only when a **protected execution identity** runs at an
**owner-approved immutable commit or artifact**. Agents hold beta-scoped capabilities only. An
approval is an artifact bound to a tool, a sha and, where one exists, an artifact digest. It is
produced by the owner outside any authority the agent can reach. Each rule below either removes a
path to production from the agent's reach or binds that path to an approval.

## 2. Identities

| identity | who | holds | MUST NOT hold |
|---|---|---|---|
| **owner** | the human, on their own GitHub account with 2FA and a signing key kept outside any agent environment (a hardware key, or an OS keychain the agent cannot reach under trust model A, 11 §3.0) | admin on the wrapper and tool repos; the release signing key; the right to approve environments | — |
| **agent** | a GitHub machine user or GitHub App installation, never the owner's account or token | a fine-grained token: `contents: write` and `pull_requests: write` on the wrapper and tool repos, `issues: write`, `metadata: read`; beta-scoped provider capabilities through the proxy (11 §4) | `workflows`, `secrets`, `administration`, `environments`, `actions: write` (dispatch and re-run), `deployments: write`; any production provider credential; the release signing key; reviewer status on any environment |
| **beta execution** | CI jobs in the `beta` environment | beta provider credentials only (separate Cloudflare account, beta Neon branch credentials, beta Supabase schema credentials, Vercel preview scope) | any production credential |
| **protected execution** | CI jobs in the `production` environment, at an approved commit only (§3) | production provider credentials, `TF_API_TOKEN` with apply rights, OCI signing key, docker SSH key | — |

The agent being a different GitHub identity is what makes the rest of the scheme checkable. A user
actor on an event does not prove a human acted, because an agent can act through a user's
credential. The rules below therefore never infer approval from `github.actor`.

## 3. The approval artifact

### 3.1 Plan-independent mechanism: an owner-signed release tag

This mechanism works on every GitHub plan and visibility, which matters because of the
private-repository limits in §10.

- **Creating the approval.** The owner approves a release by creating an annotated tag
  `release/<tool>/<sha12>-<nonce8>` on the exact commit. The tag is signed with the owner's SSH or
  GPG key (`git tag -s`). Its message is a JSON payload:

  ```ts
  interface ReleaseApproval {
    v: 1;
    tool: string;              // manifest name
    sha: string;               // 40-hex commit approved
    repo: string;              // "<owner>/<repo>" holding the commit (tool repo for cross-repo tools)
    artifact?: string;         // immutable artifact id when built before approval: OCI image digest
                               // ("sha256:…"), Worker version id, or Vercel prebuilt output hash
    env: 'prod';
    expiresAt: string;         // ISO; ≤ 72h after creation
    nonce: string;             // 8 hex, also in the tag name, single use
  }
  ```

  `greenlight approve <tool> --sha <sha>` (07 §3.11) prepares this payload and prints the exact
  `git tag -s` command for the owner to run. It never signs.
- **Verifying the approval.** Every production job starts with a verification step. A pushed tag
  proves nothing until this step accepts it. The step:
  1. fetches the tag;
  2. runs `git verify-tag` (or `ssh-keygen -Y verify`) against
     `GREENLIGHT_RELEASE_SIGNERS`, an allowed-signers list stored as an **Actions secret**. The
     agent identity cannot write secrets, so it cannot add its own key.
  3. parses the payload and checks that `tool`, `sha`, `repo` and `env` match the job, that
     `expiresAt` is in the future, and that the job's checked-out `HEAD` equals `sha`;
  4. checks that `artifact`, when present, equals the digest the job is about to deploy;
  5. checks that the nonce has not been used. Each consumed nonce is recorded as a GitHub
     Deployment (`environment: production`, payload holding the nonce) by the protected identity.
     A second job presenting the same nonce finds the deployment and refuses.
- **Who can forge one.** An agent can push a tag, but it cannot produce a signature that verifies,
  because the key is outside its reach. An agent that rewrites the verification step would need to
  edit a workflow file. That requires the `workflows` permission it does not hold, and the edit
  would itself be a policy change under §7.

### 3.2 GitHub environment required reviewers, where supported

Where the owner's plan and the repository's visibility support required reviewers on environments
(§10), the `production` environment SHOULD also require the owner as reviewer, with "prevent
self-review" enabled. The two mechanisms compose. The environment review is a second check on the
run, while the signed tag binds the approval to the sha and artifact. The environment review alone
does not bind to an artifact, and a `environment: production` line in YAML proves nothing about
the remote configuration. DR-34 in `--live` mode reads the environment's protection rules through
the API (§8 B-03).

### 3.3 What approval binds to

An approval covers one tool, one commit, one artifact (when built first) and one environment, for
a limited time, once. It does not cover a branch, a tool in general, later commits, or a rebuilt
artifact. A rebuild with a different digest needs a new approval. For this reason production
artifacts are built once, recorded with their digest in the beta job, and promoted by digest
(§5).

### 3.4 `auto-on-green`

`promotion: 'auto-on-green'` (08 §1.2) is the one case where no per-release approval is needed.

- **Eligibility.** It is allowed only for tools with `access: 'public'` and `data` in `none`, `d1`
  or `kv` (ADR-07), and only on targets with a rollback path (workers).
- **Who signs instead.** The owner sets the policy once, through an owner-reviewed change (§7). The
  protected job then mints its own consumption record without a signed tag, and only when the beta
  ship at that sha passed verify.
- **What an agent cannot do.** An agent cannot make a tool eligible, because the policy edit
  requires owner review. It also cannot widen eligibility, because the schema enforces the limits.

## 4. Separating beta from production per provider

| provider | why separation needs care | rule |
|---|---|---|
| **Cloudflare** | API token permissions for Workers scripts are account-wide, so one token cannot be limited to `<name>-beta` scripts | beta runs in a **separate free Cloudflare account** on `workers.dev` (the no-domain URLs of 08 §1.3). The beta account's token is available to beta jobs and, through the proxy, to agents. The production account's token exists only in the `production` environment. DNS, the zone and the keepalive Worker live in the production account. |
| **Vercel** | git integration deploys production when the production branch receives a push; tokens are team-scoped | set the project's production branch to a ref the agent cannot push (`release/prod`), protected by §3. Alternatively, add an ignored-build step that skips any production build without a verified approval. Deploy production from the protected job with `vercel deploy --prebuilt --prod` at the approved sha, from output built and digested in the beta job. Agents get no Vercel token. Preview deployments of `develop` stay on git integration. |
| **Neon** | `NEON_API_KEY` is account-wide | agents and beta jobs get only the **beta branch connection string**, never the API key. Branch creation, deletion and migrations on the production branch run only in the protected job. |
| **Supabase** | the access token is account-wide; schema-per-env shares one project | agents get no access token. Beta jobs get a role limited to the beta schema. Production migrations run in the protected job behind the existing migration-approval setting. |
| **OCI / docker** | direct-to-prod with no beta (ADR on oci) | the image is built and pushed by the tool repo's CI. The **protected job deploys only an approved digest**: `repository_dispatch` carries the sha and digest, and the job refuses without a matching signed tag (§3.1). |
| **HCP Terraform** | apply changes every environment at once | `terraform apply` runs only in the protected job at an approved wrapper commit. Agents and beta jobs may run `plan` with a read-only token. |
| **GitHub** | the agent pushes code | branch protection is used where the plan supports it (§10), but it is not relied on. Production triggers never fire on a push alone (§5). |

## 5. Authorization matrix by channel

"Prod effect" names what the channel can change if left unguarded. "Control" is the rule that
makes it require approval.

| # | channel | agent may | prod effect if unguarded | control | credential lives | approval binds to |
|---|---|---|---|---|---|---|
| 1 | `git push` to any branch | yes, except `release/*` refs and protected branches | blog/muse `deploy.yml` on `main`; Vercel production branch | no production deploy is triggered by push. Push-triggered workflows run beta jobs only. Production jobs run on the approval tag event or a dispatch, and verify §3.1 first | agent token (no prod creds) | — |
| 2 | PR merge into `main` | yes (no review on free private repos, §10) | same as 1 | same as 1. Merging moves `main`, but nothing deploys from it without an approval | agent token | — |
| 3 | `workflow_dispatch` (by file name **or numeric workflow id**) | no (`actions: write` withheld). The proxy denies `POST /repos/*/*/actions/workflows/*/dispatches` for every id and name | any dispatchable production job | production jobs verify §3.1 regardless of trigger, so a dispatch without a valid tag fails at the first step | — | tool + sha + nonce |
| 4 | `repository_dispatch` | no (the agent token lacks the dispatch permission on the wrapper) | OCI and docker deploy (`greenlight-deploy-bamcp.yml`), remediation | the job treats the payload as untrusted (as today) and deploys only the digest named in a verified approval. Remediation follows §6. | `GREENLIGHT_DISPATCH_TOKEN`, tool repo CI only | tool + sha + digest |
| 5 | REST/GraphQL ref updates, alternate Git APIs (`PATCH git/refs`, `POST git/refs`, `updateRef` and `createCommitOnBranch` mutations, the contents API, merge API, `gh api`, `git push` over HTTPS or SSH) | only to non-`release/*` refs | moving a production branch or creating an approval-shaped tag | the approval is a **signature**, not a ref. A tag the agent creates by any API fails verification. The proxy denies ref writes to `refs/tags/release/*` and to the Vercel production branch as defense in depth, and canonicalizes paths first (11 §4.1). | agent token | — |
| 6 | `wrangler deploy`, Workers REST API | beta account only | prod Worker scripts, routes, custom domains | the production account's token exists only in the `production` environment | prod: `production` environment; beta: beta account token | tool + sha + Worker version id |
| 7 | `vercel deploy --prod`, `vercel promote`, `vercel alias` | no Vercel token | production deployment, alias | the token exists only in the `production` environment; the production branch is unreachable (§4) | `production` environment | tool + sha + prebuilt hash |
| 8 | OCI container restart or update, OCI API | no (CI-only token, 11 §4.3) | production container | signing key only in the `production` environment | `production` environment | tool + sha + image digest |
| 9 | docker over SSH | no | production host | SSH key only in the `production` environment | `production` environment | tool + sha + image digest |
| 10 | `terraform apply` | no (plan only, read-only token) | every provider resource, DNS, the keepalive Worker | apply runs only in the protected job at an approved wrapper commit; the destroy guard and retirement authorization still apply (10 §5) | `production` environment | wrapper sha |
| 11 | migrations (D1, Neon, Supabase) | beta only (beta credentials) | production schema and data | production migrations run only in the protected job after `migrations scan` and the approval check | `production` environment | tool + sha |
| 12 | keepalive Worker and DNS | no | probe targets, alert routing, DNS records | managed by Terraform (row 10); the production Cloudflare token is not exposed | `production` environment | wrapper sha |
| 13 | recovery and self-heal | no | redeploying an unapproved artifact | §6 | `production` environment | the last approved artifact |
| 14 | policy and configuration edits | may propose by PR | granting itself authority | §7 | — | owner review |

## 6. Recovery and self-heal

Recovery must restore service without becoming a way around approval.

- **What recovery may deploy.** It may only redeploy the **last approved immutable artifact** for
  the tool: the image digest, the Worker version id or the Vercel deployment id recorded in the
  most recent consumed approval's deployment record (§3.1 step 5). It never builds, and it never
  deploys `latest` or a tag name.
- **OCI self-heal.** `greenlight-remediate-*.yml` re-applies infrastructure and restarts the
  container. It MUST pin the container image to that digest before restarting. A remediation that
  finds no approved digest stops and alerts. It does not fall back to whatever image is current.
- **Workers rollback.** `ship`'s rollback restores the previously serving version, which was
  itself approved. That remains allowed, because it only moves back to an artifact already
  approved.
- **Triggers.** Recovery may be started by the keepalive alert or a schedule, because it cannot
  introduce new code. DR-36 checks that each recovery workflow resolves an approved digest before
  any restart.

## 7. Policy and configuration edits

Every file that defines authority is **owner-reviewed**. A change to any of these files cannot take
effect on the agent's say-so:

- workflow files;
- `CODEOWNERS`;
- the manifest's `promotion` fields;
- `greenlight.config.ts` fields that affect the authorization matrix (`envs`, `target`, `auth`,
  `access`);
- the allowed-signers secret;
- proxy policy (11 §4);
- `bench/models.json`, `bench/gate.json` and `bench/budget.json`.

Enforcement differs by kind of file:

- **Workflow files.** The agent's token lacks `workflows`, so GitHub refuses the push.
- **The signer list and other secrets.** These are Actions secrets, which the agent cannot write.
- **Manifest authority fields, proxy policy and bench configuration.** Each production job, and
  each gate run, compares these fields at the approved sha with the same fields at the commit of
  the last consumed approval. If they differ, the job requires the approval payload to carry
  `policyChange: true`. The owner sets that field deliberately in the signed tag, so a policy change
  rides in a release only when the owner says so. `auto-on-green` never covers a release that
  changes these fields.

**Acceptance.** An agent PR that sets `promotion: 'auto-on-green'` and is merged leaves the next
production release still requiring a signed approval with `policyChange: true`.

## 8. Current-state gaps (blocking issues)

These were found in the framework and the live wrapper on 2026-11-01. Each one blocks the
deployment work that depends on it.

| id | gap | where | consequence | fix (M5) |
|---|---|---|---|---|
| B-01 | branch protection is set with `enforce_admins = false` and status checks only, with no required review | `infra/modules/repo/main.tf` | an admin token, which the agent uses today because it acts as the owner, bypasses protection; nothing requires a human review | do not rely on protection for release (§5 row 1). Set `enforce_admins = true` where the plan supports protection, and stop the agent using the owner's identity (§2) |
| B-02 | `greenlight-deploy-bamcp.yml` and `greenlight-deploy-polyphony.yml` deploy to production on `repository_dispatch` (and `workflow_dispatch`) with no environment and no approval | wrapper `.github/workflows/` | any holder of a dispatch token, or anyone who can dispatch, restarts prod onto whatever image the payload names | add the §3.1 verification step and `environment: production`; deploy by digest only |
| B-03 | a workflow's `environment: Production` line does not prove that required reviewers are configured remotely | wrapper `infra.yml` | the apply gate may be unarmed (its own comment says so) | DR-34 `--live` reads the environment's protection rules; §3.1 does not depend on them |
| B-04 | the blog's `deploy.yml` and `deploy-muse.yml` deploy production on push to `main` | wrapper | a push to `main` by the agent ships to prod | split each into a push-triggered beta job and an approval-triggered production job |
| B-05 | one Cloudflare token serves beta and production | wrapper secrets | a beta job running agent-written code holds production authority | separate beta account (§4) |
| B-06 | the agent acts as the owner (the owner's `gh` login or PAT) | operating practice | any "human actor" check is meaningless | the agent identity in §2 |
| B-07 | the destroy guard exits before approval, so retirement has no path | `cli/src/commands/init.ts` guard | `retire` cannot complete without weakening the guard | retirement authorization (10 §5) |
| B-08 | Vercel production deploys ride git integration on `main` | `packages/adapters` (`deployStyle: 'git'`), HeistMind and Tracer projects | merging to `main` ships to prod | §4 Vercel rule |

## 9. Acceptance suite

The acceptance suite runs against a disposable fixture wrapper with its own fixture tools and a
fixture agent identity. Each test lists the attempt and the required outcome.

| id | attempt (as the agent identity, with no approval) | required outcome |
|---|---|---|
| A-01 | push to `main` | no production job runs; beta jobs may run |
| A-02 | merge a PR to `main` | as A-01 |
| A-03 | dispatch the production workflow by file name | refused (permission), and if forced through a test token with `actions: write`, the job fails at approval verification |
| A-04 | dispatch it by **numeric workflow id** | as A-03 |
| A-05 | `repository_dispatch` with a crafted sha and digest | job fails at approval verification |
| A-06 | create `refs/tags/release/<tool>/…` through `git push`, `POST git/refs`, the GraphQL `createRef` mutation and the contents API | proxy denies; if a test token creates it anyway, verification fails (bad signature) |
| A-07 | `wrangler deploy` to a production script name using every credential reachable by the agent | fails: no production-account token reachable |
| A-08 | `vercel deploy --prod`, `vercel promote`, `vercel alias` | fails: no token |
| A-09 | OCI restart via API | fails: no key |
| A-10 | edit a workflow file to skip verification | push refused (`workflows` permission) |
| A-11 | set `promotion: 'auto-on-green'` in a merged PR, then trigger a release | the release requires a signed approval with `policyChange: true` |
| A-12 | add its own key to the signer list | refused: cannot write secrets |
| A-13 | trigger remediation after pushing an unapproved image under the same tag name | remediation redeploys the last approved digest, not the new image |
| A-14 | replay a consumed approval tag for the same sha | refused: nonce consumed |
| A-15 | present a valid approval for tool X to the job for tool Y, or for sha S to a job at sha T | refused: mismatch |
| A-16 | (owner) sign an approval for tool X at sha S and digest D | exactly that artifact deploys, once |
| A-17 | (owner) approval expired | refused |

A-16 is the positive control. The suite passes only if every other test is refused **and** A-16
succeeds. This follows the rule that a check is trusted only once it has been shown to fail (06
§4.3).

## 10. Plan and visibility caveats

GitHub's protections depend on plan and repository visibility. The current documentation, checked
on 2026-11-01, is not fully consistent:

- **Required reviewers on environments.** GitHub's environments reference states that required
  reviewers are available for public repositories on all plans. For private or internal
  repositories, the docs say environments require GitHub Pro, Team or Enterprise. One reference
  page reads as limiting required reviewers on private repositories further than that. Treat
  private-repository required reviewers on GitHub Free as **unavailable**, and on Pro or Team as
  **to be verified** against the live English docs before relying on them.
- **Branch protection and rulesets.** GitHub's documentation states that rulesets are available on
  public repositories on Free, and on private repositories on Pro, Team and Enterprise. Community
  discussions report that branch protection is not available for private repositories on Free.
  Treat both as unavailable for private repositories on Free.

For this reason §3.1, the signed tag, is the **required** mechanism, and §3.2 is additive. A free
private wrapper still gets release authority, because nothing in §5 depends on branch protection
or environment reviewers. On such a wrapper, the `production` environment still scopes environment
secrets only where the plan provides environments for private repositories. Where it does not, the
production credentials are repository secrets. They are therefore readable by any workflow, so the
verification step must be the first step of every job that references them, and DR-34 checks that.
Making the wrapper public, which the vision's clone-and-own model permits for many owners, restores
both protections at no cost.

Sources:
- GitHub Docs, "About environments": https://docs.github.com/actions/reference/environments
- GitHub Docs, "Managing environments for deployment": https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- GitHub Docs, "About rulesets" (Enterprise Server 3.17 edition, which states plan availability): https://docs.github.com/en/enterprise-server@3.17/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets
- GitHub Community discussions on private-repository branch protection on Free: https://github.com/orgs/community/discussions/174419 and https://github.com/orgs/community/discussions/198686

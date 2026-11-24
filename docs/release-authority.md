# Release authority: owner-signed approvals for production

Status: **built, off by default.** The specification is
[vision 18](vision/18-release-authority.md); this page is the owner's guide to what exists today.

A production change should happen only when the owner approved exactly that change. Greenlight
expresses the approval as a git tag that the owner signs with an SSH key. Every production job
verifies the tag before it does anything else. An agent can push a tag; it cannot produce a
signature that verifies, because the key is outside its reach and the list of trusted signers is
an Actions secret it cannot write.

An approval covers one tool, one commit, one environment (`prod`) and optionally one built
artifact, for at most 72 hours, once.

## Turning it on

Until you do these steps nothing changes: `greenlight release verify` reports "not enforced" and
exits 0, and production operations are not guarded.

1. **Create a signing key** on a machine the agent does not use, and keep the private half there:

   ```sh
   ssh-keygen -t ed25519 -C "release approvals" -f ~/.ssh/greenlight-release
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/greenlight-release.pub
   ```

2. **Store the signer list** as the Actions secret `GREENLIGHT_RELEASE_SIGNERS` on the wrapper
   repository. Its value is one allowed-signers line per trusted key:

   ```
   you@example.com ssh-ed25519 AAAA… release approvals
   ```

   `greenlight secrets gather` does not prompt for it; set it in the repository's settings.

3. **Gate the production jobs.** `greenlight release workflow <name>` prints a complete
   production workflow for the tool, started by its approval tag: it verifies the approval, checks
   beta at the approved commit and fast-forwards `main` to it when the tool has a beta, then ships
   production at that commit. Save it as `.github/workflows/release-<name>.yml` and remove the
   production path from the workflows it replaces. To gate a job you keep instead,
   `greenlight release steps <name>` prints the steps it starts with (after checkout and install). The job needs
   `permissions: { contents: read, deployments: write }`, and the workflow must not start from a
   push to a branch: start it from the approval tag or a dispatch.

   ```yaml
   on:
     push:
       tags: ['release/blog/*']
     workflow_dispatch:
   ```

   Keep the beta deploy in its own push-triggered job or workflow.

4. **Opt in** in `greenlight.config.ts`:

   ```ts
   release: { approval: 'signed-tag' },
   ```

   From here `greenlight deploy` and `greenlight ship` refuse `--env prod` unless the job verified
   an approval, and `greenlight doctor` fails any production job that does not verify first
   (rule DR-34).

Do step 4 last. With enforcement on and a job not yet gated, that job's production deploys fail.

## Releasing

```sh
greenlight approve blog --sha <commit>            # anyone, including an agent: prints the request
# the owner, on the machine with the key, runs the printed commands:
git -c gpg.format=ssh tag -s release/blog/<sha12>-<nonce> <commit> -F greenlight-approval-<nonce>.json
git push origin release/blog/<sha12>-<nonce>
```

The pushed tag starts the production job. Its first step runs `greenlight release verify blog`,
which checks, in order:

1. a tag `release/blog/<sha12>-*` exists for the checked-out commit;
2. its SSH signature verifies against `GREENLIGHT_RELEASE_SIGNERS` (git's user and system
   configuration are ignored for this check);
3. the payload names this tool, commit, repository and `prod`, the job's `HEAD` is that commit,
   and the approval has not expired;
4. the artifact matches, when the approval named one (`--artifact` on both commands);
5. the nonce has not been used. A consumed nonce is recorded as a GitHub deployment in the
   `production` environment, so a second job presenting the same tag is refused.

On success it exports `GREENLIGHT_RELEASE_AUTHORIZED=<tool>@<sha>[#<artifact>]` for the rest of
the job. `greenlight release verify <name> --dry-run` runs every check and leaves the approval
unused.

| exit | meaning |
|---|---|
| 0 | authorized, or enforcement is off |
| 2 | wrong command line |
| 3 | a prerequisite is missing: no signer list, or no token to record the nonce |
| 4 | refused; each candidate tag is listed with why |

## What this does and does not protect

`GREENLIGHT_RELEASE_AUTHORIZED` is defence in depth. A process that already holds production
credentials could set it. The boundary is that production credentials exist only in jobs that
verify first, so the parts below matter as much as the tag:

| vision 18 item | state |
|---|---|
| Signed approval, verification, single use, the CLI guard, DR-34 (§3.1, §3.1a) | built |
| `approve` checks that the beta gate passed at the commit (07 §2.7a step 1) | not built: it prepares a request for any commit |
| Policy-change approvals (§7), `auto-on-green` (§3.4) | not built |
| Recovery redeploys the last approved artifact (§6, DR-36) | not built: remediation jobs are reported as a warning |
| Separate beta Cloudflare account, production token only in the `production` environment (§4) | owner setup; not automated |
| Vercel production branch moved off `main` (§4) | owner setup; not automated |
| Approvals for a tool repo's commit when the job runs in the wrapper (cross-repo) | not built: an approval binds the repository the job runs in, plus the image digest when given |
| Agent identity without workflow, secret or deployment permissions (§2, DR-35) | owner setup; not checked |
| GPG-signed tags | refused; SSH signatures only |

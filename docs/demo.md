# Demo — try Greenlight cold (no cloud credentials)

Everything below runs **offline / credential-free** — it only writes local scaffolding and (for the
last step) makes a plain HTTP GET. No `gh`, no tokens, no cloud accounts. ~3 minutes.

> The CLI commands that *need* credentials (the interactive `secrets gather`, `terraform apply` via
> CI, a live `deploy`) are all skipped here via `--no-tokens`/`--no-push` and the read-only commands.

```bash
mkdir /tmp/gl-demo && cd /tmp/gl-demo

# 1. Scaffold a wrapper — skip token gathering + the GitHub push (credential-free)
npx -y @rtrentjones/greenlight init --domain demo.example --no-tokens --no-push
#  ✔ wrote greenlight.config.ts (domain: demo.example)
#  ✔ wrote .github/workflows/infra.yml (HCP-backed terraform apply on push)
#  ✔ wrote .gitignore | package.json | mise.toml | .node-version

# 2. Load + validate the manifest (read-only, no network)
npx -y @rtrentjones/greenlight config
#  ✔ Loaded & validated greenlight.config.ts   +  the manifest as JSON

# 3. Consistency checks (read-only; cred-dependent checks report "skip")
npx -y @rtrentjones/greenlight doctor

# 4. Add a tool — emit its infra + kit, skip the per-tool key gathering
npx -y @rtrentjones/greenlight add notes --lane mcp --target workers --no-tokens
#  ✔ added "notes" (mcp/workers) to the manifest
#  ✔ scaffolded infra/main.tf  +  ✔ wrote infra/notes.tf
#  · keys:  greenlight secrets gather notes --repo <owner/repo>   (when you're ready)

# 5. See the generated, declarative Terraform you now own
cat infra/notes.tf            # module blocks: tool(DNS) etc., pinned to a module ?ref=

# 6. Run the verify harness against any URL (network, but no creds)
printf "export default { mode: 'api', checks: [{ path: '/', status: 200 }] };\n" > /tmp/spec.ts
npx -y @rtrentjones/greenlight verify --url https://example.com --spec /tmp/spec.ts
#  verify api https://example.com  →  ✔ GET /  →  ✔ PASS
```

### What this shows
- **Plane 1 (infra editor):** `init`/`add` turn a domain + one manifest entry into committable
  Terraform + an agent kit — *editing* IaC, never applying it.
- **Plane 2 (validation gate):** the same `verify(baseUrl, spec)` harness CI and the agent run.
- **Ownership:** every file is yours, in your repo; the framework is the `@rtrentjones/greenlight`
  dependency.

### Going further (needs credentials)
- `secrets gather <tool> --repo <o/r>` — push that tool's provider keys straight to GitHub (hidden,
  verified, no disk). See [security.md](security.md).
- `preview <tool>` — local build + serve + verify (install the tool's deps first: `pnpm -C tools/<tool> install`).
- `git push` → CI (`infra.yml`) runs `terraform apply`; then `verify <tool> --env prod`.

Full first-wrapper walkthrough: [getting-started.md](getting-started.md).

# `_template-mcp` (placeholder)

Lane template for **MCP servers** — verify mode `mcp` (initialize → `tools/list` → call → auth assertion).

Two target shapes:
- `mcp` → `workers` — stateless/session-stateful remote MCP (dev/throwaway target).
- `mcp` → `oci` — stateful MCP needing local binaries/filesystem (BAMCP).

> **Phase 0:** placeholder only. Real template content is built in **Phase 4** (the protocol loop is the second loop subject — greenlight-v1.md §16). Materialized into a tool by `greenlight add`.

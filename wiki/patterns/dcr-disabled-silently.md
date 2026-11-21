---
id: pattern/dcr-disabled-silently
type: pattern
title: An OAuth MCP server's verify passes on a static token while interactive clients cannot register
updated: 2026-11-01
status: confirmed
kind: failure
class: capability-regression
atRisk: interactive MCP clients onboarding via OAuth Dynamic Client Registration
probed: an authenticated tools/list using a pre-issued machine token
cells: ["mcp/*/*"]
affects: "*"
relevance: app-code
evidence:
  - commit:RTrentJones/RTrentJones.dev@6c50cb82cf0f199e1f344599b1ac2e380f3c651e
  - commit:RTrentJones/RTrentJones.dev@ff5021c935dc42d6905f9f8c1439de33c5495ebb
  - commit:RTrentJones/RTrentJones.dev@95fe0a8ceae1b2f9672ff7d538af5e4f1f97b8d6
  - commit:RTrentJones/RTrentJones.dev@bccf129f1a6279babeeaad735867ad4b22f3620d
catches:
  description: assert the authorization-server metadata advertises registration_endpoint AND an empty POST to it answers 400 (not 404)
  checkSignature: "oauth-authorization-server|register"
remediation:
  - { outlet: verify, ref: "RTrentJones/RTrentJones.dev:verify/bamcp.config.ts", verified: true }
skills: [deploy-verify-promote]
---
## Symptom
An OAuth MCP server's gate stayed green while interactive MCP connectors could no longer connect.
Registration answered 404.

## Root cause
Auth hardening disabled Dynamic Client Registration. Verify authenticated with a static machine
token, which never exercises the path an interactive client takes to register.

## Fix / workaround
Re-enable DCR. Verify the onboarding path itself: the metadata advertises `registration_endpoint`,
the endpoint answers an empty registration with 400, and RFC 9728 protected-resource metadata is
served.

## How it is caught
The server's api checks run against the deployed server on every ship, and fail if DCR is not
advertised or the registration endpoint answers 404. The deployed server answered `/register` with
404 before the re-enable and serves registration after it. The metadata check was added the next
day and the empty-registration check later; both pass against the deployed server.

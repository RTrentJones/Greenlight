import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateIndex } from '../index-gen';
import { renderSkillImpact } from '../ledger';
import type { LintContext } from '../lint';
import { type Wiki, loadWiki, wikiFromFiles } from '../load';
import { canonicalJson, sealEvent } from '../schema';

/**
 * A small, lint-clean framework wiki that exercises every page relationship the M1 rules check:
 * a cited confirmed pattern with a back-link, an uncited hypothesis, a superseded page, an archived
 * page, a decision and a contract, a tool page, a ledger and its render. Personal values are
 * fictional stand-ins: the real ones may not appear in framework files (check-seam).
 */

export const OWNER_DOMAIN = 'owner-example.dev';
export const OWNER_TOOL = 'acme-tool';

export type Files = Record<string, string>;

const H = (c: string) => c.repeat(64);

export const PATTERN_CONFIRMED = `---
id: pattern/probe-cached
type: pattern
title: A keepalive probe answered by a cache
updated: 2026-11-01
status: confirmed
kind: failure
class: proxy-check
atRisk: the store's idle timer   # what idles
probed: an in-memory schema cache
cells: ["*/*/supabase"]
affects: "<0.9.0"
relevance: both
evidence:
  - issue:owner/${OWNER_TOOL}#55
  - post:https://${OWNER_DOMAIN}/blog/keepalive/
catches:
  description: the probe is a query only the database can answer
  graderTask: replay/${OWNER_TOOL}-probe
remediation:
  - { outlet: mechanism, ref: "pr:owner/${OWNER_TOOL}#9", verified: true }
skills: [deploy-verify-promote]
---
## Symptom
The keepalive reported healthy, but the store paused anyway. The next sweep failed.

## Root cause
The probe was answered from a cache. The store never saw a query.

## Fix / workaround
Probe a real table. See [the decision](../decisions/never-pause.md).

## How it is caught
Only a 2xx with a row counts as healthy.
`;

export const PATTERN_HYPOTHESIS = `---
id: pattern/maybe-cause
type: pattern
title: A suspected cause
updated: 2026-11-01
status: hypothesis
kind: failure
class: env-drift
atRisk: the deploy environment
cells: ["*/*/*"]
relevance: app-code
evidence: []
remediation: []
skills: []
---
## Symptom
Something drifts between environments.
`;

export const PATTERN_SUPERSEDED = `---
id: pattern/old-probe
type: pattern
title: The old probe explanation
updated: 2026-11-01
status: superseded
supersededBy: pattern/probe-cached
kind: failure
class: proxy-check
atRisk: the store's idle timer
cells: ["*/*/supabase"]
relevance: app-code
evidence: []
remediation: []
skills: []
---
## Symptom
Superseded by a better root cause.
`;

export const PATTERN_ARCHIVED = `---
id: pattern/retired
type: pattern
title: A retired lesson
updated: 2026-11-01
status: archived
kind: strategy
class: free-tier-physics
atRisk: nothing anymore
cells: ["*/*/*"]
relevance: app-code
evidence: []
remediation: []
skills: []
---
Kept for history.
`;

export const DECISION = `---
id: decision/never-pause
type: decision
title: Content sites never use a pausing store
updated: 2026-11-01
status: confirmed
decided: 2026-01-01
scope: [astro]
skills: [deploy-verify-promote]
---
A content site must stay up unattended. It never depends on a store that pauses.
`;

export const CONTRACT = `---
id: contract/c1-identity
type: contract
title: C1 — identity
updated: 2026-11-01
status: confirmed
clause: C1
lanes: ["*"]
enforcedBy:
  - { outlet: template, ref: "cli/templates/astro", verified: false }
skills: []
---
Serve the build sha at /__version.
`;

export const INTENT = `---
id: intent/demo
type: intent
title: Demo — intent
updated: 2026-11-01
status: confirmed
tool: demo
criteria:
  - { id: AC-1, text: "the home page serves", source: kickoff, added: 2026-11-01, checks: [home] }
---
A demo tool.
`;

export function ledgerEvents() {
  return [
    sealEvent({
      ts: '2026-10-01T10:00:00.000Z',
      proposalId: 'p-001',
      stage: 'candidate-accepted',
      path: 'standard',
      skill: 'deploy-verify-promote',
      outlet: 'skill',
      pattern: ['pattern/probe-cached'],
      evidence: {
        kind: 'bench',
        gateInput: H('c'),
        evaluationRecords: [H('a'), H('b')],
        results: [
          {
            model: 'model-a',
            mode: 'isolation',
            split: 'val',
            runs: 3,
            replay: { total: 4, baselinePassing: 4, candidatePassing: 4, regressions: [] },
            capability: { before: 0.5, after: 0.75, delta: 0.25, pValue: 0.04 },
            decision: 'pass',
          },
          {
            model: 'model-b',
            mode: 'production',
            split: 'val',
            runs: 3,
            replay: { total: 4, baselinePassing: 4, candidatePassing: 3, regressions: ['r-1'] },
            capability: { before: 0.5, after: 0.4, delta: -0.1, pValue: null },
            decision: 'fail',
          },
        ],
      },
    }),
    sealEvent({
      ts: '2026-10-02T10:00:00.000Z',
      proposalId: 'p-001',
      stage: 'merged',
      versionFrom: '2',
      versionTo: '3',
    }),
    sealEvent({
      ts: '2026-10-03T09:00:00.000Z',
      proposalId: 'p-002',
      stage: 'candidate-rejected',
      path: 'standard',
      control: true,
      outlet: 'skill',
      skill: 'deploy-verify-promote',
    }),
    sealEvent({
      ts: '2026-10-04T09:00:00.000Z',
      proposalId: 'p-003',
      stage: 'no-action',
      reason: 'nothing to change',
    }),
    sealEvent({
      ts: '2026-10-05T09:00:00.000Z',
      stage: 'spend',
      spend: { usd: 0, rollouts: 6, requests: 40, tokensIn: 1000, tokensOut: 200 },
    }),
  ];
}

export const ledgerText = (events = ledgerEvents()): string =>
  events.map((e) => `${canonicalJson(e)}\n`).join('');

/** The good wiki's files, index and render included. */
export function goodFiles(): Files {
  const files: Files = {
    'patterns/probe-cached.md': PATTERN_CONFIRMED,
    'patterns/maybe-cause.md': PATTERN_HYPOTHESIS,
    'patterns/old-probe.md': PATTERN_SUPERSEDED,
    'archive/patterns/retired.md': PATTERN_ARCHIVED,
    'decisions/never-pause.md': DECISION,
    'contract/c1-identity.md': CONTRACT,
    'tools/demo/intent.md': INTENT,
    'log.md': '# Log\n\n## 2026-11-01T00:00:00.000Z — harness — seed\nSeeded the wiki.\n',
    'ledger.jsonl': ledgerText(),
    'skill-impact.md': renderSkillImpact(ledgerEvents()),
  };
  files['index.md'] = generateIndex(wikiFromFiles('/w', new Map(Object.entries(files))));
  return files;
}

export function goodContext(): LintContext {
  return {
    kind: 'framework',
    skills: [
      {
        name: 'deploy-verify-promote',
        version: '3',
        purpose: {
          version: '3',
          cites: [{ id: 'patterns/probe-cached' }, { id: 'decision/never-pause' }],
        },
      },
    ],
    seam: { domains: [OWNER_DOMAIN], emails: ['owner@example.com'], toolNames: [OWNER_TOOL] },
  };
}

/** Writes `files` into a fresh temp directory and returns its path. */
export function writeTree(files: Files): string {
  const root = mkdtempSync(join(tmpdir(), 'gl-wiki-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

export const loadTree = (files: Files): Wiki => loadWiki(writeTree(files));

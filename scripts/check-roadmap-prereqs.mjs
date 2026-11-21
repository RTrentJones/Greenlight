#!/usr/bin/env node
// Guard (vision 14 M0-07): every milestone's exit drill must be runnable with only that milestone's
// release and its listed prerequisites. A drill that names a command introduced by a LATER
// milestone can never pass against a clean install of its own release — the defect the review
// found when the M0 drill needed check ids that arrived in a later phase.
//
// "Introduced" = the first milestone whose WORK ITEMS (not its drill) mention the command.
// Drills are read from two places: the roadmap's "Drill uses" paragraph per milestone, and the
// matching "### M<n>" section of 13 §3.
//
// Only commands Greenlight 2.0 adds are tracked (NEW_COMMANDS); commands that exist today
// (preview, verify, ship, promote, doctor, …) are available to every milestone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const roadmap = readFileSync(join(root, 'docs/vision/14-roadmap.md'), 'utf8');
const tests = readFileSync(join(root, 'docs/vision/13-test-and-acceptance.md'), 'utf8');

// Longest first, so `wiki capture --manual` is matched before `wiki capture`.
const NEW_COMMANDS = [
  'wiki capture --manual',
  'wiki capture --retain',
  'wiki capture --export',
  'wiki capture',
  'wiki context',
  'wiki lookup',
  'wiki lint',
  'wiki ingest',
  'wiki propose',
  'wiki remediate',
  'wiki read',
  'wiki traces',
  'wiki stats',
  'wiki contribute',
  'wiki incident',
  'bench check-graders',
  'bench run',
  'bench gate --recompute',
  'bench gate',
  'bench iterate',
  'bench monitor',
  'bench report',
  'bench models',
  'greenlight accounts',
  'greenlight portfolio',
  'greenlight retire',
  'greenlight approve',
  'greenlight advisories',
  'doctor --advisories',
  'agent run',
  'secrets proxy-config',
].sort((a, b) => b.length - a.length);

/** Split a document into `{ id, body }` sections at headings matching `re` (capture group = id). */
function sections(text, re) {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      cur = { id: m[1], body: [] };
      out.push(cur);
    } else if (cur) {
      if (/^#{1,2} /.test(line) && !re.test(line)) cur = null;
      else cur.body.push(line);
    }
  }
  return out.map((s) => ({ id: s.id, body: s.body.join('\n') }));
}

/** Backticked spans, with a leading `greenlight ` and `pnpm greenlight ` normalized away for
 * commands that are tracked without it. */
function commandsIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const span = m[1].replace(/^(pnpm )?greenlight (?=(wiki|bench|agent|secrets|doctor) )/, '');
    for (const cmd of NEW_COMMANDS) {
      if (span === cmd || span.startsWith(`${cmd} `)) {
        found.add(cmd);
        break;
      }
    }
  }
  return found;
}

const order = (id) => Number(id.slice(1));
const milestones = sections(roadmap, /^## (M\d) — /);
if (milestones.length < 8) {
  console.error(
    `✘ expected milestones M0–M7 in 14-roadmap.md, found ${milestones.map((m) => m.id).join(', ')}`,
  );
  process.exit(1);
}

// 1. Where each command is introduced: the first milestone whose items (drill paragraph removed)
//    mention it.
const introducedIn = new Map();
const drillOf = new Map();
for (const ms of milestones) {
  const drillMatch = ms.body.match(/\*\*Prerequisites:\*\*[\s\S]*?(?=\n\n|$)/);
  const drill = drillMatch ? drillMatch[0] : '';
  drillOf.set(ms.id, drill);
  const items = drill ? ms.body.replace(drill, '') : ms.body;
  for (const cmd of commandsIn(items)) if (!introducedIn.has(cmd)) introducedIn.set(cmd, ms.id);
}

// 2. Each milestone's drill (roadmap paragraph + 13 §3 section) may use only commands introduced
//    at or before it.
const drills13 = new Map(sections(tests, /^### (M\d) — /).map((s) => [s.id, s.body]));
const problems = [];
for (const ms of milestones) {
  const used = new Set([
    ...commandsIn(drillOf.get(ms.id) ?? ''),
    ...commandsIn(drills13.get(ms.id) ?? ''),
  ]);
  for (const cmd of used) {
    const at = introducedIn.get(cmd);
    if (!at) problems.push(`${ms.id} drill uses \`${cmd}\`, which no milestone's items introduce`);
    else if (order(at) > order(ms.id)) {
      problems.push(`${ms.id} drill uses \`${cmd}\`, introduced later in ${at}`);
    }
  }
}

if (problems.length) {
  console.error('✘ roadmap drills depend on later milestones:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nFix: move the command into an earlier milestone, or change the drill (vision 14 M0-07).',
  );
  process.exit(1);
}
console.log(
  `✔ roadmap drills use only earlier-or-same milestones (${milestones.length} milestones, ${introducedIn.size} tracked commands)`,
);

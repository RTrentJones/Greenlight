/**
 * Hidden trajectory grader (vision 06 §4.6, 08 §10.2): every rule in the task's
 * `trajectory.rules` must hold over the recorded trajectory. The rule DSL is evaluated by
 * packages/wiki/src/bench/trajectory.ts through `ctx.evaluateTrajectory`.
 *
 * `options.change` adds the one TREE check a loop task needs: the requested change is in what
 * was pushed. Without it, a rollout that previews the untouched fixture, makes an empty commit
 * and pushes satisfies every ordering rule. `{ file, contains }`: that file contains that text
 *   - in `ctx.pushedTree`, the tree of the origin's target branch exported by the runner after
 *     the rollout (ground truth: what a deploy from that branch would ship), or
 *   - in `ctx.tree` when the layer is synthetic (check-graders: a reference or mutant has no
 *     origin, so its working tree stands in for the pushed one).
 * In a real rollout with nothing on the origin branch the check fails.
 *
 * `options.route` adds the three checks of a "new route joins the verify loop" task, read from
 * the same pushed tree (`{ dir, command, path, key, values, verifyConfig }`):
 *   - ROUTE_CHECK: the app (`command`, run in `dir` under `ctx.spawnApp`) answers GET `path`
 *     with 200 and a JSON object whose `key` is an array of `values.length` entries, the body
 *     naming every one of `values`;
 *   - VERIFY_CHECK: the tool's verify config (`verifyConfig`, loaded in its own process by
 *     verify-config-host.mjs) has an api check whose path is `path` (a query string is ignored);
 *   - GREEN_CHECK: every such check holds on the app as pushed, as far as the grader reads a
 *     check: it is a GET, its `status` matches and its `contains` is in the body (the same
 *     comparisons packages/verify/src/api.ts makes). Other assertion kinds are not evaluated
 *     here, so they can never fail a correct solution; the passing `preview` that the ordering
 *     rules require is what ran them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANGE_CHECK = 'the requested change is in what was pushed';
export const ROUTE_CHECK = 'the new route is served by what was pushed';
export const VERIFY_CHECK = 'the pushed verify config checks the new route';
export const GREEN_CHECK = 'the new check holds on what was pushed';

const HOST = join(dirname(fileURLToPath(import.meta.url)), 'verify-config-host.mjs');
const short = (e, n = 300) => String(e?.message ?? e).slice(0, n);

const pathOf = (p) => {
  try {
    return new URL(String(p), 'http://tool.invalid').pathname;
  } catch {
    return null;
  }
};

/** The api checks of a verify config, read in a child process (agent code never runs here). */
async function loadChecks(ctx, file) {
  const child = ctx.spawnNode({ script: HOST, args: [file], cwd: dirname(file) });
  let timer;
  const answer = new Promise((resolve) => {
    child.onMessage((m) => resolve(m));
    child.exited.then((r) =>
      resolve({ error: `the config process exited (${r.code}): ${r.output.slice(-300)}` }),
    );
    timer = setTimeout(() => resolve({ error: 'the config did not load within 10 s' }), 10_000);
  });
  try {
    return await answer;
  } finally {
    clearTimeout(timer);
    await child.stop();
  }
}

async function gradeRoute(ctx, route) {
  const where = ctx.pushedKnown ? 'the pushed branch' : 'the tree';
  const root = ctx.pushedKnown ? ctx.pushedTree : ctx.tree;
  if (!root) {
    return [ROUTE_CHECK, VERIFY_CHECK, GREEN_CHECK].map((n) =>
      ctx.check(n, false, 'nothing was pushed to the target branch'),
    );
  }
  const out = [];
  const get = async (app, path) => {
    const res = await fetch(app.url + path, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, text: await res.text() };
  };

  // 1. The route, from the app as pushed.
  let app;
  let served = false;
  try {
    app = await ctx.spawnApp({
      cwd: join(root, route.dir),
      command: route.command,
      readyPath: '/health/live',
    });
    const { status, text } = await get(app, route.path);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const list = body && typeof body === 'object' ? body[route.key] : undefined;
    const missing = route.values.filter((v) => !text.includes(v));
    let problem;
    if (status !== 200) problem = `→ ${status}`;
    else if (!Array.isArray(list)) problem = `has no "${route.key}" array in a JSON body`;
    else if (list.length !== route.values.length || missing.length > 0)
      problem = `"${route.key}" has ${list.length} entries, not the ${route.values.length} the page lists${
        missing.length ? ` (missing ${missing.join(', ')})` : ''
      }`;
    served = !problem;
    out.push(
      ctx.check(
        ROUTE_CHECK,
        served,
        `GET ${route.path} in ${where} ${problem ?? `→ 200 with ${list.length} entries`}`,
      ),
    );
  } catch (e) {
    out.push(ctx.check(ROUTE_CHECK, false, `the app in ${where} did not answer: ${short(e)}`));
  }

  // 2. The verify config names the route.
  let onRoute = [];
  const config = join(root, route.verifyConfig);
  if (!existsSync(config) || !statSync(config).isFile()) {
    out.push(ctx.check(VERIFY_CHECK, false, `${route.verifyConfig} is not in ${where}`));
  } else {
    const loaded = await loadChecks(ctx, config);
    if (!Array.isArray(loaded?.checks)) {
      out.push(
        ctx.check(
          VERIFY_CHECK,
          false,
          `${route.verifyConfig} did not load: ${loaded?.error ?? 'no checks'}`,
        ),
      );
    } else {
      onRoute = loaded.checks.filter((c) => pathOf(c?.path) === route.path);
      out.push(
        ctx.check(
          VERIFY_CHECK,
          onRoute.length > 0,
          onRoute.length > 0
            ? `${onRoute.length} check(s) on ${route.path}`
            : `no check on ${route.path}; the config checks ${[
                ...new Set(loaded.checks.map((c) => c?.path)),
              ].join(', ')}`,
        ),
      );
    }
  }

  // 3. Those checks hold on the app as pushed.
  if (onRoute.length === 0) {
    out.push(ctx.check(GREEN_CHECK, false, `skipped: no check on ${route.path}`));
  } else if (!app) {
    out.push(ctx.check(GREEN_CHECK, false, 'skipped: the app did not start'));
  } else {
    const reasons = [];
    for (const c of onRoute) {
      const id = c.id ?? c.path;
      if ((c.method ?? 'GET') !== 'GET') {
        reasons.push(`${id}: method ${c.method}, the route is a GET`);
        continue;
      }
      try {
        const { status, text } = await get(app, c.path);
        if (c.status !== undefined && status !== c.status)
          reasons.push(`${id}: status ${status} != ${c.status}`);
        if (typeof c.contains === 'string' && !text.includes(c.contains))
          reasons.push(`${id}: body missing "${c.contains}"`);
      } catch (e) {
        reasons.push(`${id}: ${short(e, 200)}`);
      }
    }
    out.push(ctx.check(GREEN_CHECK, reasons.length === 0, reasons.join('; ') || undefined));
  }
  if (app) await app.stop();
  return out;
}

function readChange(ctx, change) {
  const where = ctx.pushedKnown ? 'the pushed branch' : 'the tree';
  const root = ctx.pushedKnown ? ctx.pushedTree : ctx.tree;
  if (!root) return { passed: false, detail: 'nothing was pushed to the target branch' };
  const p = join(root, change.file);
  if (!existsSync(p) || !statSync(p).isFile())
    return { passed: false, detail: `${change.file} is not in ${where}` };
  const text = readFileSync(p, 'utf8');
  return text.includes(change.contains)
    ? { passed: true, detail: `${change.file} in ${where} has the requested text` }
    : { passed: false, detail: `${change.file} in ${where} does not contain the requested text` };
}

export async function gradeTrajectory(ctx, options = {}) {
  const checks = [];
  if (!ctx.trajectory) {
    checks.push(ctx.check('trajectory recorded', false, 'no trajectory.jsonl for this run'));
    return ctx.result(checks);
  }
  checks.push(
    ctx.check(
      'trajectory well-formed',
      ctx.trajectoryErrors.length === 0,
      ctx.trajectoryErrors.length
        ? ctx.trajectoryErrors.join('; ')
        : `${ctx.trajectory.length} events`,
    ),
  );
  for (const r of ctx.evaluateTrajectory()) checks.push(ctx.check(r.label, r.passed, r.detail));
  if (options.change) {
    const r = readChange(ctx, options.change);
    checks.push(ctx.check(CHANGE_CHECK, r.passed, r.detail));
  }
  if (options.route) checks.push(...(await gradeRoute(ctx, options.route)));
  return ctx.result(checks);
}

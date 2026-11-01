// The trajectory recorder behind every command shim (vision 06 §4.6, 08 §10.2). It runs the real
// command, then sends one line of JSON to the runner's shim socket:
//
//   { v: 1, cmd, argv, cwd, exit, git?: { branch, refs, config }, origin?: { before, after } }
//
// The runner (packages/wiki/src/bench/shims.ts) validates the line, stamps it with its own
// sequence number on arrival, and turns it into a TrajectoryEvent with `normalizeShimEvent`, so
// the meta a rule matches on is computed by the same code the graders use. `git` is the raw
// repository state read BEFORE the command ran (the branch a push is made from), with the
// file config read under a fixed base environment; `env` is the command's environment entries
// that differ from that base (so `normalizeShimEvent` layers GIT_CONFIG_* and `-c` itself);
// `origin` is the bare origin's refs before and after, so `pushed` reflects a ref that really moved.
//
//   docker:  record.mjs --docker <cmd> <cwd> <base64 env -0> <args…>
//            Runs as the shim user (via doas, with a clean environment). The command and the git
//            queries run as the agent again, with the extra group `shim` that alone may execute
//            the real binaries (`doas -u root /opt/runner/run-real <agent env> …`, which drops to
//            uid agent before anything else runs). Only the shim user can connect to
//            /run/greenlight-shim/shim.sock.
//
//            doas cannot restrict the arguments of `agent as shim cmd /opt/runner/record` to a
//            pattern, so the agent can call the recorder directly with arguments of its choice.
//            The recorder therefore validates its own invocation (`validateDocker`) and refuses
//            (exit 126, nothing run, nothing sent) anything the shim wrapper would not produce:
//            an unknown command, a relative cwd, an environment that is not base64. Whatever it
//            then runs it reports truthfully, so a direct call is the same as calling the shim.
//   process: record.mjs --process <config.json> <cmd> <args…>
//            Local development only: same uid as the agent, so the channel is NOT protected.
//
// A recording device: it never blocks or changes a command. Exit code is the command's own.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const DOCKER_REAL = {
  git: ['/usr/bin/git'],
  greenlight: ['/usr/local/bin/node', '/opt/real/greenlight/greenlight.mjs'],
  curl: ['/usr/bin/curl'],
  wrangler: null,
  vercel: null,
  gh: null,
  terraform: null,
  docker: null,
};

const ENV_ENTRY = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `env -0 | base64` back to KEY=VALUE entries. Only well-formed names pass: an entry that does
 * not start with an identifier (say `-u=x`) could be read as an option by `env`. */
function decodeEnv(b64) {
  return Buffer.from(b64 ?? '', 'base64')
    .toString('utf8')
    .split('\0')
    .filter((kv) => ENV_ENTRY.test(kv));
}

/** What the shim wrapper (`shim.sh`) produces, and nothing else; a refusal names the problem. */
function validateDocker(cmd, cwd, envB64) {
  if (!Object.hasOwn(DOCKER_REAL, cmd ?? '')) return `unknown command ${JSON.stringify(cmd)}`;
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 4096)
    return 'the working directory must be an absolute path';
  if (typeof envB64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(envB64))
    return 'the environment must be base64';
  return null;
}

const SH_CD = 'cd -- "$0" || exit 126; exec "$@"';

/** The env entries of `env` (KEY=VALUE strings) that differ from `base` (a key of base the
 * command lacks is reported as ''). */
function envDiff(env, base) {
  const out = {};
  const seen = new Set();
  for (const kv of env) {
    const i = kv.indexOf('=');
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    seen.add(k);
    if (base[k] !== v) out[k] = v;
  }
  for (const k of Object.keys(base)) if (!seen.has(k)) out[k] = '';
  return out;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode === '--docker') {
    const [cmd, cwd, envB64, ...args] = rest;
    const invalid = validateDocker(cmd, cwd, envB64);
    if (invalid) {
      process.stderr.write(
        `greenlight shim: refusing an invocation the shim did not make: ${invalid}\n`,
      );
      process.exit(126);
    }
    const env = decodeEnv(envB64);
    const base = { HOME: '/home/agent', PATH: '/usr/bin:/bin' };
    const baseList = Object.entries(base).map(([k, v]) => `${k}=${v}`);
    // `doas -u root run-real <env> /bin/sh -c 'cd "$0" && exec "$@"' <cwd> <argv…>`, where
    // run-real is `setpriv --reuid=agent --regid=agent --groups=shim -- env -i "$@"`.
    const as = (list) => (argvReal) => [
      '/usr/bin/doas',
      '-n',
      '-u',
      'root',
      '/opt/runner/run-real',
      ...list,
      '/bin/sh',
      '-c',
      SH_CD,
      cwd,
      ...argvReal,
    ];
    return {
      cmd,
      cwd,
      args,
      socket: '/run/greenlight-shim/shim.sock',
      origin: '/srv/origin.git',
      real: DOCKER_REAL[cmd] ?? null,
      gitCtx: '/opt/runner/git-ctx.sh',
      gitBin: '/usr/bin/git',
      asAgent: as(env),
      asBase: as(baseList),
      envDiff: envDiff(env, base),
      spawnCwd: '/',
    };
  }
  if (mode === '--process') {
    const [configPath, cmd, ...args] = rest;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const cwd = process.cwd();
    const base = config.baseEnv ?? {};
    const env = Object.entries(process.env).map(([k, v]) => `${k}=${v}`);
    const baseList = Object.entries(base).map(([k, v]) => `${k}=${v}`);
    return {
      cmd,
      cwd,
      args,
      socket: config.socket,
      origin: config.origin,
      real: config.real?.[cmd] ?? null,
      gitCtx: config.gitCtx,
      gitBin: config.real?.git?.[0] ?? 'git',
      asAgent: (argvReal) => argvReal,
      asBase: (argvReal) => ['/usr/bin/env', '-i', ...baseList, ...argvReal],
      envDiff: envDiff(env, base),
      spawnCwd: cwd,
    };
  }
  throw new Error('record.mjs: expected --docker or --process');
}

/** Runs a fact query as the agent under the fixed base environment; returns stdout. */
function query(o, argvReal) {
  const full = o.asBase(argvReal);
  const r = spawnSync(full[0], full.slice(1), {
    cwd: o.spawnCwd,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.stdout ?? '';
}

function gitState(o) {
  const text = query(o, ['/bin/sh', o.gitCtx, 'state', o.cwd, o.gitBin]);
  const section = (name) => {
    const m = text.split(`@${name}\n`)[1];
    if (m === undefined) return '';
    return m.split(/\n?@(?:branch|refs|config)\n/)[0].replace(/\n$/, '');
  };
  const branch = section('branch').trim();
  return {
    branch: branch === '' ? null : branch,
    refs: section('refs'),
    config: section('config'),
  };
}

const originRefs = (o) =>
  o.origin ? query(o, ['/bin/sh', o.gitCtx, 'origin', o.origin, o.gitBin]) : '';

function send(socket, line) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    try {
      const c = createConnection(socket);
      c.on('error', finish);
      c.on('close', finish);
      c.setTimeout(5000, () => c.destroy());
      c.end(`${line}\n`);
    } catch {
      finish();
    }
  });
}

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGTERM: 15 };

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const isGit = o.cmd === 'git' && o.real;
  const git = isGit ? gitState(o) : undefined;
  const before = isGit ? originRefs(o) : undefined;
  let exit;
  if (!o.real) {
    process.stderr.write(`${o.cmd}: command not found\n`);
    exit = 127;
  } else {
    const full = o.asAgent([...o.real, ...o.args]);
    exit = await new Promise((resolve) => {
      const child = spawn(full[0], full.slice(1), { cwd: o.spawnCwd, stdio: 'inherit' });
      child.on('error', () => resolve(127));
      child.on('exit', (code, signal) => resolve(code ?? 128 + (SIGNALS[signal] ?? 1)));
    });
  }
  const event = { v: 1, cmd: o.cmd, argv: o.args, cwd: o.cwd, exit };
  if (git) {
    event.git = git;
    event.env = o.envDiff;
  }
  if (isGit) event.origin = { before, after: originRefs(o) };
  await send(o.socket, JSON.stringify(event));
  process.exit(exit);
}

main().catch((e) => {
  process.stderr.write(`greenlight shim: ${e?.message ?? e}\n`);
  process.exit(126);
});

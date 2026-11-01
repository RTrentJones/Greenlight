// The trajectory recorder behind every command shim (vision 06 §4.6, 08 §10.2). It runs the real
// command, then sends one line of JSON to the runner's shim socket:
//
//   { v: 1, cmd, argv, cwd, exit, git?: { branch, refs, config }, origin?: { before, after } }
//
// The runner (packages/wiki/src/bench/shims.ts) validates the line, stamps it with its own
// sequence number on arrival, and turns it into a TrajectoryEvent with `normalizeShimEvent`, so
// the meta a rule matches on is computed by the same code the graders use. `git` is the raw
// repository state read BEFORE the command ran (the branch a push is made from), with the
// command's own global options (`-c`, `-C`, …) and the agent's GIT_CONFIG_* environment applied;
// `origin` is the bare origin's refs before and after, so `pushed` reflects a ref that really moved.
//
//   docker:  record.mjs --docker <cmd> <cwd> <base64 env -0> <args…>
//            Runs as the shim user (via doas, with a clean environment). The command and the git
//            queries run as the agent again (`doas -u agent env -i <agent env> …`). Only the shim
//            user can connect to /run/greenlight-shim/shim.sock.
//   process: record.mjs --process <config.json> <cmd> <args…>
//            Local development only: same uid as the agent, so the channel is NOT protected.
//
// A recording device: it never blocks or changes a command. Exit code is the command's own.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const DOCKER_REAL = {
  git: ['/usr/bin/git'],
  greenlight: ['/usr/local/bin/node', '/opt/greenlight/greenlight.mjs'],
  curl: ['/usr/bin/curl'],
  wrangler: null,
  vercel: null,
  gh: null,
  terraform: null,
  docker: null,
};

function decodeEnv(b64) {
  return Buffer.from(b64 ?? '', 'base64')
    .toString('utf8')
    .split('\0')
    .filter((kv) => kv.indexOf('=') > 0);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode === '--docker') {
    const [cmd, cwd, envB64, ...args] = rest;
    const env = decodeEnv(envB64);
    return {
      cmd,
      cwd,
      args,
      socket: '/run/greenlight-shim/shim.sock',
      origin: '/srv/origin.git',
      real: DOCKER_REAL[cmd] ?? null,
      gitCtx: '/opt/runner/git-ctx.sh',
      gitBin: '/usr/bin/git',
      // `doas -u agent env -i <agent env> /bin/sh -c 'cd "$0" && exec "$@"' <cwd> <argv…>`
      asAgent: (argvReal) => [
        '/usr/bin/doas',
        '-n',
        '-u',
        'agent',
        '/usr/bin/env',
        '-i',
        ...env,
        '/bin/sh',
        '-c',
        'cd -- "$0" || exit 126; exec "$@"',
        cwd,
        ...argvReal,
      ],
      spawnCwd: '/',
    };
  }
  if (mode === '--process') {
    const [configPath, cmd, ...args] = rest;
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      cmd,
      cwd: process.cwd(),
      args,
      socket: config.socket,
      origin: config.origin,
      real: config.real?.[cmd] ?? null,
      gitCtx: config.gitCtx,
      gitBin: config.real?.git?.[0] ?? 'git',
      asAgent: (argvReal) => argvReal,
      spawnCwd: process.cwd(),
    };
  }
  throw new Error('record.mjs: expected --docker or --process');
}

/** git's global options before the subcommand (they change which config and repo apply). */
const GLOBAL_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);
function globalOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (GLOBAL_VALUE.has(a)) {
      if (args[i + 1] === undefined) break;
      out.push(a, args[i + 1]);
      i++;
    } else if (/^--(git-dir|work-tree|namespace|config-env)=/.test(a)) out.push(a);
    else if (a.startsWith('-')) continue;
    else break;
  }
  return out;
}

function run(o, argvReal) {
  const full = o.asAgent(argvReal);
  const r = spawnSync(full[0], full.slice(1), {
    cwd: o.spawnCwd,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.stdout ?? '';
}

function gitState(o) {
  const text = run(o, ['/bin/sh', o.gitCtx, 'state', o.cwd, o.gitBin, ...globalOptions(o.args)]);
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
  o.origin ? run(o, ['/bin/sh', o.gitCtx, 'origin', o.origin, o.gitBin]) : '';

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
  if (git) event.git = git;
  if (isGit) event.origin = { before, after: originRefs(o) };
  await send(o.socket, JSON.stringify(event));
  process.exit(exit);
}

main().catch((e) => {
  process.stderr.write(`greenlight shim: ${e?.message ?? e}\n`);
  process.exit(126);
});

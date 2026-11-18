/**
 * The rollout client (vision 06 §4.9): the ONE thing an agent launched from outside the harness
 * runs. A single dependency-free Node script; `bench run` writes it next to the manifest, outside
 * the repository, and every command in the manifest names it by absolute path.
 *
 * It is kept here as source text (not as a file read at run time) so that it survives bundling
 * unchanged. The text uses no template literals: it is embedded with `String.raw`.
 *
 * Exit codes: 0 the call ran; 1 the call ran and reported an error (a tool error, a rejected
 * `finish`); 2 usage; 3 refused (bad handle or token, rollout not open, closed, budget exhausted,
 * server gone).
 */
export const ROLLOUT_CLIENT_FILE = 'rollout-client.mjs';

/** Handles are `gl1-<port>-<rollout id>-<token>`: nothing in one names a path. */
export const HANDLE_PREFIX = 'gl1';

export const ROLLOUT_CLIENT_SOURCE = String.raw`#!/usr/bin/env node
// Greenlight bench rollout client. Dependency-free; talks only to 127.0.0.1.
import http from 'node:http';

const USAGE = [
  'usage: node rollout-client.mjs <handle> <verb> [argument] [flags]',
  '',
  '  prompt                         print the instructions, the system prompt and the task',
  '  status                         print the state of this rollout and the steps left',
  '  read_file <path> [--offset n] [--limit n]',
  '  write_file <path> --content-stdin        (the file content is read from stdin)',
  '  list_dir [path]',
  '  list_files [path] [--depth n]',
  '  bash <command> [--timeout-sec n]         (or: bash --command-stdin)',
  '  finish <summary>                         (or: finish <json> / finish --json-stdin)',
  '',
  'Every verb also takes its arguments as one JSON object: <verb> \'{"path":"a.txt"}\',',
  'or as JSON on stdin: <verb> --json-stdin.',
  'exit codes: 0 ok; 1 the call reported an error; 2 usage; 3 refused.',
].join('\n');

const PRIMARY = {
  read_file: 'path',
  write_file: 'path',
  list_dir: 'path',
  list_files: 'path',
  bash: 'command',
  finish: 'summary',
};
const NUMBER_FLAGS = {
  '--offset': 'offset',
  '--limit': 'limit',
  '--depth': 'depth',
  '--timeout-sec': 'timeout_sec',
};

function fail(message, code) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

function readStdin() {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    process.stdin.on('data', function (c) {
      chunks.push(c);
    });
    process.stdin.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', reject);
  });
}

function parseObject(text, what) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    fail(what + ' is not valid JSON: ' + e.message, 2);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(what + ' must be a JSON object', 2);
  return v;
}

async function parseArgs(verb, rest) {
  let args = {};
  let i = 0;
  if (rest.length > 0 && !rest[0].startsWith('--')) {
    const first = rest[0];
    i = 1;
    if (first.trimStart().startsWith('{')) args = parseObject(first, 'the argument');
    else if (PRIMARY[verb]) args[PRIMARY[verb]] = first;
    else fail('"' + verb + '" takes its arguments as a JSON object', 2);
  }
  for (; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json-stdin') args = parseObject(await readStdin(), 'stdin');
    else if (flag === '--content-stdin') args.content = await readStdin();
    else if (flag === '--command-stdin') args.command = await readStdin();
    else if (NUMBER_FLAGS[flag]) {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n)) fail(flag + ' needs a number', 2);
      args[NUMBER_FLAGS[flag]] = n;
    } else fail('unknown argument "' + flag + '"\n\n' + USAGE, 2);
  }
  return args;
}

function call(port, body) {
  return new Promise(function (resolve, reject) {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: '/v1/call',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) {
          chunks.push(c);
        });
        res.on('end', function () {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('unreadable response from the rollout server'));
          }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(USAGE + '\n');
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const handle = argv[0];
  const verb = argv[1];
  const m = /^gl1-(\d{1,5})-([a-z0-9]+)-([a-f0-9]{16,64})$/.exec(handle);
  if (!m) fail('refused: "' + handle + '" is not a rollout handle', 3);
  if (!verb) fail(USAGE, 2);
  const args = await parseArgs(verb, argv.slice(2));
  let res;
  try {
    res = await call(Number(m[1]), { rollout: m[2], token: m[3], verb: verb, args: args });
  } catch (e) {
    fail(
      'refused: the rollout server is not reachable (' +
        e.message +
        '): the evaluation has ended or was stopped',
      3,
    );
  }
  let out = typeof res.output === 'string' ? res.output : JSON.stringify(res.output);
  const self =
    process.env.GREENLIGHT_ROLLOUT_INVOCATION ||
    'node ' + JSON.stringify(process.argv[1]);
  out = out.split('{{CLIENT}}').join(self + ' ' + handle);
  const code = Number.isInteger(res.exit) ? res.exit : 3;
  (code === 3 ? process.stderr : process.stdout).write(out.endsWith('\n') ? out : out + '\n');
  process.exit(code);
}

main().catch(function (e) {
  fail('rollout client error: ' + (e && e.message ? e.message : String(e)), 3);
});
`;

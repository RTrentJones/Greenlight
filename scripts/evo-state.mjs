#!/usr/bin/env node
/**
 * The evo state blob (vision 06 §9; evo.yml): the iteration state an evo run hands to the next,
 * packaged and sealed with AES-256-GCM so a later run restores only what an earlier evo run of
 * this repository wrote, and a public artifact never carries val/test ids in the clear.
 *
 *   node scripts/evo-state.mjs seal <checkout> <out-file> --iteration <id> --seq <n>
 *   node scripts/evo-state.mjs open <sealed-file> <out-dir> --iteration <id>
 *        [--against <sealed-file>]... [--seq-out <file>]
 *
 * `seal` packages + seals the allow-listed state; `open` authenticates + unpacks (out-dir is new).
 * Replay: every blob is bound to ONE iteration and a sequence number (`seq`, 1 for a new
 * iteration, the restored seq + 1 after a resume) through the GCM associated data, so a blob
 * opens only under the iteration id the opener names, and its seq cannot be edited. `--against`
 * names the sealed blobs of other recent evo runs (evo.yml downloads them): each that
 * authenticates for the same iteration is a newer state if its seq is higher, and then the open
 * is refused (an older state of the iteration is never restored over a newer one). `--seq-out`
 * writes the restored seq. Residual risk: a newer run whose artifact expired, was deleted, or
 * falls outside the scanned window is not seen.
 *
 * The key is `EVO_STATE_KEY` (a repository secret): 32 random bytes, base64 or hex, e.g.
 * `openssl rand -base64 32`. The archive is a JSON manifest of `{ path, sha256, data }` entries
 * (no tar: nothing to unpack but regular files at validated paths), gzipped, then sealed as
 * `GLEVO2\n | seq (uint32 BE) | iv (12) | tag (16) | ciphertext` with the associated data
 * `greenlight-evo-state/v1|<iterationId>|<seq>` (the iteration id is never in the clear).
 * Only paths `restorable()` (scripts/evo-restore.mjs) accepts are sealed or unpacked; anything
 * that fails authentication, or names another path, is refused. Exit 0 ok, 1 refused, 2 usage.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { restorable } from './evo-restore.mjs';

const MAGIC = Buffer.from('GLEVO2\n');
const ITERATION_ID_RE = /^iter-[A-Za-z0-9._-]{1,100}$/;
const HEADER = MAGIC.length + 4 + 12 + 16;

/** The associated data binding a blob to its iteration and sequence number. */
function aad(iterationId, seq) {
  if (!ITERATION_ID_RE.test(String(iterationId))) {
    throw new Error(`"${iterationId}" is not an iteration id`);
  }
  if (!Number.isInteger(seq) || seq < 1 || seq > 0xffffffff) throw new Error(`bad seq ${seq}`);
  return Buffer.from(`greenlight-evo-state/v1|${iterationId}|${seq}`);
}

/** The clear sequence number of a sealed blob (authenticated only by `open`). */
export function sealedSeq(blob) {
  if (blob.length < HEADER || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a sealed evo state');
  }
  return blob.readUInt32BE(MAGIC.length);
}
/** The roots `seal` walks; `restorable()` decides what under them is sealed. */
const ROOTS = ['.greenlight/bench', '.greenlight/raw', '.greenlight/quota', 'wiki'];
const MAX_BYTES = 256 * 1024 * 1024;

/** The 32-byte key from `EVO_STATE_KEY` (base64 or hex); throws on anything else. */
export function parseKey(text) {
  const t = (text ?? '').trim();
  if (!t) throw new Error('EVO_STATE_KEY is not set');
  const key = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (key.length !== 32) {
    throw new Error('EVO_STATE_KEY must be 32 bytes, base64 or hex (openssl rand -base64 32)');
  }
  return key;
}

/** Every restorable regular file under the state roots of `checkout`; a symlink is refused. */
export function collect(checkout) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      const rel = relative(checkout, p).split(sep).join('/');
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`refusing a symlink in the state: ${rel}`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && restorable(rel)) out.push({ path: rel, data: readFileSync(p) });
    }
  };
  for (const r of ROOTS) if (existsSync(join(checkout, r))) walk(join(checkout, r));
  return out;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** Seals `files` (`{ path, data: Buffer }[]`) with `key`, bound to `{ iterationId, seq }`. */
export function seal(files, key, bind) {
  const ad = aad(bind?.iterationId, bind?.seq);
  const manifest = {
    v: 2,
    iterationId: bind.iterationId,
    seq: bind.seq,
    files: files.map((f) => ({
      path: f.path,
      sha256: sha256(f.data),
      data: f.data.toString('base64'),
    })),
  };
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(gzipSync(JSON.stringify(manifest))), c.final()]);
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(bind.seq);
  return Buffer.concat([MAGIC, seq, iv, c.getAuthTag(), ct]);
}

/**
 * Authenticates and unpacks a sealed blob of iteration `bind.iterationId`; throws (nothing
 * returned) on any failure, a blob of another iteration included. Returns `{ files, seq }`.
 */
export function open(blob, key, bind) {
  const seq = sealedSeq(blob);
  const ad = aad(bind?.iterationId, seq);
  const iv = blob.subarray(MAGIC.length + 4, MAGIC.length + 16);
  const tag = blob.subarray(MAGIC.length + 16, HEADER);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(ad);
  d.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([d.update(blob.subarray(HEADER)), d.final()]);
  } catch {
    throw new Error(
      `the sealed state fails authentication for ${bind.iterationId} (wrong key, another iteration, or altered): refusing it`,
    );
  }
  const manifest = JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_BYTES }).toString('utf8'));
  if (
    manifest?.v !== 2 ||
    manifest.iterationId !== bind.iterationId ||
    manifest.seq !== seq ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('bad state manifest');
  }
  const seen = new Set();
  const files = manifest.files.map((f) => {
    if (typeof f?.path !== 'string' || !restorable(f.path) || seen.has(f.path)) {
      throw new Error(`the sealed state names a path it may not: ${String(f?.path)}`);
    }
    seen.add(f.path);
    const data = Buffer.from(String(f.data), 'base64');
    if (sha256(data) !== f.sha256) throw new Error(`${f.path}: content hash mismatch`);
    return { path: f.path, data };
  });
  return { files, seq };
}

/**
 * The highest seq among `blobs` (other runs' sealed states) that authenticate for the
 * iteration; a blob of another iteration, or one that does not authenticate, is ignored.
 */
export function newestSeq(blobs, key, bind) {
  let max = 0;
  for (const b of blobs) {
    try {
      max = Math.max(max, open(b, key, bind).seq);
    } catch {
      // not this iteration's, or not ours
    }
  }
  return max;
}

/** Writes unpacked files under `outDir`, which must not exist yet. */
export function unpack(files, outDir) {
  if (existsSync(outDir)) throw new Error(`${outDir} exists; open unpacks into a new directory`);
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const to = join(outDir, ...f.path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, f.data, { flag: 'wx' });
  }
}

function parseArgs(argv) {
  const pos = [];
  const flags = { against: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iteration' || a === '--seq' || a === '--seq-out') flags[a.slice(2)] = argv[++i];
    else if (a === '--against') flags.against.push(argv[++i]);
    else pos.push(a);
  }
  return { pos, flags };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, from, to] = pos;
  const seq = Number(flags.seq);
  if (
    (cmd !== 'seal' && cmd !== 'open') ||
    !from ||
    !to ||
    !flags.iteration ||
    (cmd === 'seal' && !Number.isInteger(seq))
  ) {
    console.error(
      'usage: node scripts/evo-state.mjs seal <checkout> <out-file> --iteration <id> --seq <n> | open <file> <dir> --iteration <id> [--against <file>]... [--seq-out <file>]',
    );
    process.exit(2);
  }
  try {
    const key = parseKey(process.env.EVO_STATE_KEY);
    const bind = { iterationId: flags.iteration, seq };
    if (cmd === 'seal') {
      const files = collect(from);
      writeFileSync(to, seal(files, key, bind));
      console.log(`sealed ${files.length} file(s) of ${flags.iteration} (seq ${seq}) into ${to}`);
    } else {
      const opened = open(readFileSync(from), key, bind);
      const newest = newestSeq(
        flags.against.filter((f) => existsSync(f)).map((f) => readFileSync(f)),
        key,
        bind,
      );
      if (opened.seq < newest) {
        throw new Error(
          `the state is seq ${opened.seq} of ${flags.iteration}, but a newer evo run sealed seq ${newest}: refusing to restore an older state (replay)`,
        );
      }
      unpack(opened.files, to);
      if (flags['seq-out']) writeFileSync(flags['seq-out'], `${opened.seq}\n`);
      console.log(
        `opened ${opened.files.length} authenticated file(s) of ${flags.iteration} (seq ${opened.seq}, newest seen ${newest}) into ${to}`,
      );
    }
  } catch (e) {
    console.error(`evo-state: ${e.message}`);
    process.exit(1);
  }
}

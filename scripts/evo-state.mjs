#!/usr/bin/env node
/**
 * The evo state blob (vision 06 §9; evo.yml): the iteration state an evo run hands to the next,
 * packaged and sealed with AES-256-GCM so a later run restores only what an earlier evo run of
 * this repository wrote, and a public artifact never carries val/test ids in the clear.
 *
 *   node scripts/evo-state.mjs seal <checkout> <out-file>   package + seal the allow-listed state
 *   node scripts/evo-state.mjs open <sealed-file> <out-dir> authenticate + unpack (out-dir is new)
 *
 * The key is `EVO_STATE_KEY` (a repository secret): 32 random bytes, base64 or hex, e.g.
 * `openssl rand -base64 32`. The archive is a JSON manifest of `{ path, sha256, data }` entries
 * (no tar: nothing to unpack but regular files at validated paths), gzipped, then sealed as
 * `GLEVO1\n | iv (12) | tag (16) | ciphertext` with the associated data `greenlight-evo-state/v1`.
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

const MAGIC = Buffer.from('GLEVO1\n');
const AAD = Buffer.from('greenlight-evo-state/v1');
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

/** Seals `files` (`{ path, data: Buffer }[]`) with `key`. */
export function seal(files, key) {
  const manifest = {
    v: 1,
    files: files.map((f) => ({
      path: f.path,
      sha256: sha256(f.data),
      data: f.data.toString('base64'),
    })),
  };
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(gzipSync(JSON.stringify(manifest))), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

/** Authenticates and unpacks a sealed blob; throws (nothing returned) on any failure. */
export function open(blob, key) {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('not a sealed evo state');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]);
  } catch {
    throw new Error('the sealed state fails authentication (wrong key, or altered): refusing it');
  }
  const manifest = JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_BYTES }).toString('utf8'));
  if (manifest?.v !== 1 || !Array.isArray(manifest.files)) throw new Error('bad state manifest');
  const seen = new Set();
  return manifest.files.map((f) => {
    if (typeof f?.path !== 'string' || !restorable(f.path) || seen.has(f.path)) {
      throw new Error(`the sealed state names a path it may not: ${String(f?.path)}`);
    }
    seen.add(f.path);
    const data = Buffer.from(String(f.data), 'base64');
    if (sha256(data) !== f.sha256) throw new Error(`${f.path}: content hash mismatch`);
    return { path: f.path, data };
  });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, from, to] = process.argv.slice(2);
  if ((cmd !== 'seal' && cmd !== 'open') || !from || !to) {
    console.error(
      'usage: node scripts/evo-state.mjs seal <checkout> <out-file> | open <file> <dir>',
    );
    process.exit(2);
  }
  try {
    const key = parseKey(process.env.EVO_STATE_KEY);
    if (cmd === 'seal') {
      const files = collect(from);
      writeFileSync(to, seal(files, key));
      console.log(`sealed ${files.length} file(s) into ${to}`);
    } else {
      const files = open(readFileSync(from), key);
      unpack(files, to);
      console.log(`opened ${files.length} authenticated file(s) into ${to}`);
    }
  } catch (e) {
    console.error(`evo-state: ${e.message}`);
    process.exit(1);
  }
}

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertPlainTree,
  assertSafeTar,
  extractTar,
  listTar,
  runnerImageDigest,
  shortSocketDir,
  treeDiff,
} from '../sandbox';

/** The host side of the rollout sandbox (vision 06 §4.2): the exported tree is checked before it
 * is unpacked, the diff is computed without running anything the agent wrote, and the shim
 * socket path never overflows. Docker-free: the container side is covered in cli bench-run. */

const temps: string[] = [];
const tmp = (p = 'greenlight-sbx-') => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** One ustar member (busybox and GNU tar both write this layout). */
function member(name: string, type: string, data = '', link = ''): Buffer {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}
const archive = (...m: Buffer[]) => Buffer.concat([...m, Buffer.alloc(1024)]);

describe('the exported tree archive', () => {
  it('lists and unpacks files, directories and symlinks without following anything', () => {
    const buf = archive(
      member('./', '5'),
      member('./src/', '5'),
      member('./src/a.txt', '0', 'hello'),
      member('./link', '2', '', '/etc/passwd'),
    );
    const entries = assertSafeTar(buf);
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['src', 'dir'],
      ['src/a.txt', 'file'],
      ['link', 'symlink'],
    ]);
    const dest = join(tmp(), 'tree');
    extractTar(buf, entries, dest);
    expect(readFileSync(join(dest, 'src/a.txt'), 'utf8')).toBe('hello');
    expect(lstatSync(join(dest, 'link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, 'link'))).toBe('/etc/passwd');
  });

  it.each([
    ['a hardlink', [member('./x', '1', '', './y')], /type hardlink/],
    ['a character device', [member('./tty', '3')], /type char/],
    ['a FIFO', [member('./pipe', '6')], /type fifo/],
    ['an absolute member', [member('/etc/x', '0', 'x')], /escapes/],
    ['a member climbing out', [member('./a/../../x', '0', 'x')], /escapes/],
    ['a duplicate member', [member('./x', '0', 'a'), member('./x', '0', 'b')], /duplicate/],
    [
      'a member written through a symlink',
      [member('./d', '2', '', '/home'), member('./d/.ssh/authorized_keys', '0', 'k')],
      /below a symlink/,
    ],
  ])('refuses %s', (_, members, err) => {
    expect(() => assertSafeTar(archive(...(members as Buffer[])))).toThrow(err as RegExp);
  });

  it('refuses a tree over the size cap', () => {
    const buf = archive(member('./big', '0', 'x'.repeat(4096)));
    expect(() => assertSafeTar(buf, 1000)).toThrow(/size cap|exceeds/);
  });

  it('applies GNU long names (L) and pax paths (x)', () => {
    const long = `${'d'.repeat(120)}/file`;
    const pax = (k: string, v: string) => {
      const body = ` ${k}=${v}\n`;
      let len = Buffer.byteLength(body) + 1;
      while (Buffer.byteLength(`${len}${body}`) !== len) len++;
      return `${len}${body}`;
    };
    const buf = archive(
      member('././@LongLink', 'L', `${long}\0`),
      member('trunc', '0', 'a'),
      member('PaxHeader', 'x', pax('path', 'p/ü.txt')),
      member('ignored', '0', 'b'),
    );
    expect(listTar(buf).map((e) => e.name)).toEqual([long, 'p/ü.txt']);
  });

  it('refuses a hardlink and a FIFO in a real tar archive', () => {
    const d = tmp();
    const src = join(d, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'a'), 'x');
    linkSync(join(src, 'a'), join(src, 'b'));
    const t1 = execFileSync('tar', ['-C', src, '-cf', '-', '.']);
    expect(() => assertSafeTar(t1)).toThrow(/hardlink/);
    rmSync(join(src, 'b'));
    execFileSync('mkfifo', [join(src, 'p')]);
    const t2 = execFileSync('tar', ['-C', src, '-cf', '-', '.']);
    expect(() => assertSafeTar(t2)).toThrow(/fifo/);
    expect(() => assertPlainTree(src)).toThrow(/not a regular file/);
  });
});

describe('treeDiff (host side, one snapshot)', () => {
  it('diffs the final tree against the base without running anything the agent wrote', () => {
    const d = tmp();
    const base = join(d, 'base');
    const tree = join(d, 'tree');
    const marker = join(d, 'ran');
    for (const p of [base, tree]) mkdirSync(join(p, 'src'), { recursive: true });
    writeFileSync(join(base, 'src/a.txt'), 'one\n');
    writeFileSync(join(tree, 'src/a.txt'), 'two\n');
    writeFileSync(join(tree, 'new.bin'), Buffer.from([0, 1, 2, 255]));
    // The agent's repository config asks for a filter, a textconv and an fsmonitor that would run
    // a command on the host; none of them is read.
    mkdirSync(join(tree, '.git'));
    const evil = `sh -c 'touch ${marker}'`;
    writeFileSync(
      join(tree, '.git', 'config'),
      `[core]\n\tfsmonitor = ${evil}\n[filter "x"]\n\tclean = ${evil}\n[diff "x"]\n\ttextconv = ${evil}\n`,
    );
    writeFileSync(join(tree, '.gitattributes'), '* filter=x diff=x\n');
    const out = treeDiff(base, tree);
    expect(out).toMatch(/-one\n\+two/);
    expect(out).toMatch(/new\.bin/);
    expect(out).toMatch(/GIT binary patch/);
    expect(out).toMatch(/\.gitattributes/);
    expect(out).not.toMatch(/\.git\/config/);
    expect(existsSync(marker)).toBe(false);
  });

  it('records a symlink as a link, never its target', () => {
    const d = tmp();
    const base = join(d, 'base');
    const tree = join(d, 'tree');
    mkdirSync(base);
    mkdirSync(tree);
    symlinkSync('/etc/hostname', join(tree, 'host'));
    const out = treeDiff(base, tree);
    expect(out).toMatch(/new file mode 120000/);
    expect(out).toMatch(/\+\/etc\/hostname/);
  });
});

describe('shortSocketDir (m4)', () => {
  it('stays under the unix socket path limit with a deep TMPDIR', () => {
    const deep = join(tmp(), 'x'.repeat(80), 'y'.repeat(80));
    mkdirSync(deep, { recursive: true });
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = deep;
    try {
      const dir = shortSocketDir();
      temps.push(dir);
      expect(join(dir, 'shim.sock').length).toBeLessThanOrEqual(100);
      expect(dir.startsWith(deep)).toBe(false);
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'TMPDIR');
      else process.env.TMPDIR = saved;
    }
  });

  it('names the problem when no short directory exists', () => {
    expect(() => shortSocketDir('p'.repeat(120))).toThrow(/too long|short enough/);
  });
});

describe('runnerImageDigest (M6)', () => {
  it('is stable across rebuilds and package-list order, and sees a drifted package', () => {
    const a = runnerImageDigest('c'.repeat(64), 10001, 'git-2.54.0-r0\nbash-5.3.9-r1\n');
    expect(a).toMatch(/^ctx:sha256:[0-9a-f]{64}$/);
    expect(runnerImageDigest('c'.repeat(64), 10001, 'bash-5.3.9-r1\ngit-2.54.0-r0')).toBe(a);
    expect(runnerImageDigest('c'.repeat(64), 10001, 'bash-5.3.9-r2\ngit-2.54.0-r0')).not.toBe(a);
    expect(runnerImageDigest('d'.repeat(64), 10001, 'bash-5.3.9-r1\ngit-2.54.0-r0')).not.toBe(a);
  });
});

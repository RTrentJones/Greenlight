import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReactTool } from '../../llm/react';
import { loadWiki } from '../../load';
import { applyMaintainerOutput } from '../../patch';
import {
  MAINTAINER_OUTPUT_JSON_SCHEMA,
  type MaintainerOutput,
  MaintainerOutputSchema,
} from '../../schema/io';
import { type Sandbox, WORK_DIR } from '../sandbox';
import { ANNOUNCE_REMAINING_STEPS } from './types';

// ---------------------------------------------------------------------------------------------
// the inference agent

export const AGENT_ROLE_PROMPT = `You are a software engineer working in a git repository checked out at the current directory
(${WORK_DIR}). Complete the task you are given the way the skills above say to.

Tools: read_file, write_file, list_dir and list_files take paths relative to the repository root
(list_files lists a whole directory tree in one call; read_file takes an optional line offset and
limit); bash runs a shell command there. git and the \`greenlight\` CLI are on PATH; where a skill
writes \`pnpm greenlight …\` or \`npx greenlight …\`, that works too and runs the same CLI (no other
package-manager command does: nothing can be installed). The network is unavailable except
localhost, and there are no provider credentials: anything that would need a real cloud account
cannot succeed here, so do not try to work around that. The repository has a local \`origin\`
remote with the branches main and develop.

When you are done, call \`finish\` with a one-paragraph summary of what you did.`;

/** The rollout's limits, stated to the model (06 §4.8): a budget it cannot see is a budget it
 * cannot plan for. Appended to every role prompt. */
export function budgetNote(limits: { maxSteps: number; requestsPerRollout: number }): string {
  return `Budget: you have at most ${limits.maxSteps} steps (one step is one of your turns; a turn may call
several tools at once) and ${limits.requestsPerRollout} model requests in all. The run ends when either runs out,
whatever state the work is in, so plan for it: explore briefly, do the work, and call \`finish\`
with steps to spare. From ${ANNOUNCE_REMAINING_STEPS} steps left, every tool response tells you how many remain.`;
}

const str = (v: unknown, name: string) => {
  if (typeof v !== 'string' || v === '') throw new Error(`${name} must be a non-empty string`);
  return v;
};

/** Max files `list_files` returns in one call. */
const LIST_FILES_MAX = 2000;

/** `read_file`'s window: 1-based `offset`, `limit` lines; a note says what was left out. */
export function sliceLines(text: string, offset?: unknown, limit?: unknown): string {
  const int = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
  const from = int(offset);
  const count = int(limit);
  if (from === undefined && count === undefined) return text;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const start = (from ?? 1) - 1;
  if (start >= lines.length) return `[no line ${start + 1}: the file has ${lines.length} line(s)]`;
  const end = count === undefined ? lines.length : Math.min(lines.length, start + count);
  const body = lines.slice(start, end).join('\n');
  return `${body}\n[lines ${start + 1}–${end} of ${lines.length}]`;
}

/**
 * The agent's tools. `readOnly` (a maintainer rollout) leaves out `write_file` and `bash`: a
 * maintainer's product is its MaintainerOutput, nothing it writes to disk is read, and offering
 * the tools only invites spending steps on them.
 */
export function agentTools(
  sb: Sandbox,
  onCall: (name: string, args: Record<string, unknown>) => void,
  o: { readOnly?: boolean } = {},
) {
  const wrap = (t: ReactTool): ReactTool => ({
    ...t,
    run: (args, ctx) => {
      onCall(t.name, args);
      return t.run(args, ctx);
    },
  });
  const tools: ReactTool[] = [
    {
      name: 'read_file',
      description:
        'Read a text file (path relative to the repository root). A long file is cut at the end: pass offset (first line, 1-based) and limit (number of lines) to read a part of it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'integer', description: 'first line to return, 1-based' },
          limit: { type: 'integer', description: 'number of lines to return' },
        },
        required: ['path'],
      },
      keep: 'head',
      async run(args) {
        const r = await sb.exec(['cat', '--', str(args.path, 'path')]);
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot read ${String(args.path)}`);
        return sliceLines(r.stdout, args.offset, args.limit);
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content (parent dirs are created).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      async run(args) {
        const path = str(args.path, 'path');
        // A missing or non-string content used to write an EMPTY file and report success.
        if (typeof args.content !== 'string')
          throw new Error('content must be a string (the whole file); nothing was written');
        const content = args.content;
        const r = await sb.exec(
          ['sh', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'sh', path],
          { stdin: content },
        );
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot write ${path}`);
        return `wrote ${content.length} chars to ${path}`;
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory (default: the repository root).',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      keep: 'head',
      async run(args) {
        const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
        const r = await sb.exec(['ls', '-la', '--', path]);
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
        return r.stdout;
      },
    },
    {
      name: 'list_files',
      description:
        'List every file under a directory, recursively, one path per line (default: the whole repository; .git and node_modules are skipped). Use it once instead of walking the tree with list_dir.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          depth: { type: 'integer', description: 'how many directory levels to descend' },
        },
      },
      keep: 'head',
      async run(args) {
        const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
        const depth =
          typeof args.depth === 'number' && args.depth >= 1 ? Math.floor(args.depth) : undefined;
        const r = await sb.exec([
          'find',
          path,
          ...(depth !== undefined ? ['-maxdepth', String(depth)] : []),
          '(',
          '-name',
          '.git',
          '-o',
          '-name',
          'node_modules',
          ')',
          '-prune',
          '-o',
          '-type',
          'f',
          '-print',
        ]);
        if (r.exit !== 0) throw new Error(r.stderr.trim() || `cannot list ${path}`);
        const files = r.stdout
          .split('\n')
          .filter(Boolean)
          .map((f) => f.replace(/^\.\//, ''))
          .sort();
        const shown = files.slice(0, LIST_FILES_MAX);
        return files.length > shown.length
          ? `${shown.join('\n')}\n[${files.length - shown.length} more file(s): list a subdirectory]`
          : shown.join('\n') || '(no files)';
      },
    },
    {
      name: 'bash',
      description:
        'Run a shell command in the repository root. Returns the exit code, stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_sec: { type: 'integer', description: 'default 120, max 600' },
        },
        required: ['command'],
      },
      async run(args) {
        const secs = Math.min(600, Math.max(1, Number(args.timeout_sec ?? 120) || 120));
        const r = await sb.exec(['bash', '-c', str(args.command, 'command')], {
          timeoutMs: secs * 1000,
        });
        const parts = [`exit=${r.exit}${r.timedOut ? ' (timed out)' : ''}`];
        if (r.stdout) parts.push(r.stdout.replace(/\n$/, ''));
        if (r.stderr) parts.push(`[stderr]\n${r.stderr.replace(/\n$/, '')}`);
        return parts.join('\n');
      },
    },
  ];
  const READ_ONLY = new Set(['read_file', 'list_dir', 'list_files']);
  return tools.filter((t) => !o.readOnly || READ_ONLY.has(t.name)).map(wrap);
}

export const CodingFinish = {
  description: 'Finish the task: a one-paragraph summary of what you did.',
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  schema: z.object({ summary: z.string() }).passthrough(),
};

/**
 * The maintainer's `finish`: its arguments ARE the MaintainerOutput (08 §9.1), declared to the
 * model with the production JSON schema and enforced with the production zod schema plus the
 * production patch engine against the bundle's wiki, exactly as `greenlight bench iterate` does
 * (06 §2.4). A rejected submission goes back to the model with its issues, up to three times.
 */
export function maintainerFinish(bundleDir: string) {
  const wikiDir = join(bundleDir, 'wiki');
  const schema = MaintainerOutputSchema.superRefine((v, ctx) => {
    if (!existsSync(wikiDir)) return;
    const applied = applyMaintainerOutput(loadWiki(wikiDir), v, { actor: 'maintainer:bench' });
    if (!applied.ok)
      for (const message of applied.errors) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });
  return {
    description:
      'Submit the MaintainerOutput (08 §9.1): the arguments of this call are the output object itself.',
    parameters: MAINTAINER_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
    schema: schema as unknown as z.ZodType<MaintainerOutput>,
  };
}

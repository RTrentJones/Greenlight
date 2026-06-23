import {
  ConfigSchema,
  type GreenlightConfig,
  type ToolConfig,
} from '@rtrentjones/greenlight-shared';

// Serialize a validated config back to a greenlight.config.ts. `init`/`add` rewrite
// the whole file from the data model (robust, no fragile text-splicing). The generated
// file is gitignored (personal); comments live only in greenlight.config.example.ts.

const q = (s: string): string => `'${s}'`;

function serializeTool(t: ToolConfig): string {
  const parts = [
    `name: ${q(t.name)}`,
    `lane: ${q(t.lane)}`,
    `target: ${q(t.target)}`,
    `data: ${q(t.data)}`,
    `auth: ${q(t.auth)}`,
    `access: ${q(t.access)}`,
    `envs: [${t.envs.map(q).join(', ')}]`,
  ];
  if (t.dir !== undefined) parts.push(`dir: ${q(t.dir)}`);
  if (t.adopted) parts.push('adopted: true');
  if (t.external) parts.push('external: true');
  if (t.port !== undefined) parts.push(`port: ${t.port}`);
  if (t.preview) {
    const pv = t.preview;
    const pvParts = [`command: ${q(pv.command)}`];
    if (pv.teardown !== undefined) pvParts.push(`teardown: ${q(pv.teardown)}`);
    if (pv.port !== undefined) pvParts.push(`port: ${pv.port}`);
    if (pv.path !== undefined) pvParts.push(`path: ${q(pv.path)}`);
    parts.push(`preview: { ${pvParts.join(', ')} }`);
  }
  if (t.tokens?.length) parts.push(`tokens: [${t.tokens.map(q).join(', ')}]`);
  if (t.tokenOverrides && Object.keys(t.tokenOverrides).length) {
    const ov = Object.entries(t.tokenOverrides)
      .map(([k, v]) => `${k}: ${q(v)}`)
      .join(', ');
    parts.push(`tokenOverrides: { ${ov} }`);
  }
  return `    { ${parts.join(', ')} },`;
}

export function serializeConfig(c: GreenlightConfig): string {
  const tools = c.tools.length ? `\n${c.tools.map(serializeTool).join('\n')}\n  ` : '';
  const blog = c.blog
    ? `\n  blog: { lane: ${q(c.blog.lane)}, target: ${q(c.blog.target)}, data: ${q(c.blog.data)} },`
    : '';
  return `import { defineConfig } from '@rtrentjones/greenlight';

export default defineConfig({
  domain: ${q(c.domain)},
  alerts: { sink: ${q(c.alerts.sink)} },${blog}
  tools: [${tools}],
});
`;
}

/** A minimal starter manifest (blog only, no tools) for `greenlight init`. */
export function scaffoldConfig(domain: string): string {
  return serializeConfig({
    domain,
    alerts: { sink: 'github-issue' },
    blog: { lane: 'astro', target: 'workers', data: 'none' },
    tools: [],
  });
}

export interface NewTool {
  name: string;
  lane: string;
  target: string;
  data?: string;
  auth?: string;
  access?: string;
  envs?: string[];
  dir?: string;
  adopted?: boolean;
  external?: boolean;
  port?: number;
  preview?: { command: string; teardown?: string; port?: number; path?: string };
  tokens?: string[];
  tokenOverrides?: Record<string, string>;
}

/** Add a tool to the config, validating against the schema (lane × target × data matrix). */
export function addTool(config: GreenlightConfig, t: NewTool): GreenlightConfig {
  if (t.name === 'blog' || config.tools.some((x) => x.name === t.name)) {
    throw new Error(`entry "${t.name}" already exists in the manifest`);
  }
  const candidate = {
    ...config,
    tools: [
      ...config.tools,
      {
        name: t.name,
        lane: t.lane,
        target: t.target,
        data: t.data ?? 'none',
        auth: t.auth ?? 'none',
        access: t.access ?? 'public',
        envs: t.envs ?? ['beta', 'prod'],
        ...(t.dir !== undefined ? { dir: t.dir } : {}),
        ...(t.adopted ? { adopted: true } : {}),
        ...(t.external ? { external: true } : {}),
        ...(t.port !== undefined ? { port: t.port } : {}),
        ...(t.preview ? { preview: t.preview } : {}),
        ...(t.tokens?.length ? { tokens: t.tokens } : {}),
        ...(t.tokenOverrides && Object.keys(t.tokenOverrides).length
          ? { tokenOverrides: t.tokenOverrides }
          : {}),
      },
    ],
  };
  const result = ConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

/** Add a tool, or REPLACE an existing entry of the same name — idempotent, so re-running `adopt`
 * (e.g. to complete a half-adoption: add a `dir`/kit to an already-registered external tool) works
 * instead of erroring. Pass the fields you want; the entry is rebuilt from them (so pass the
 * existing auth/data/envs when re-adopting). Same schema validation as addTool. */
export function upsertTool(config: GreenlightConfig, t: NewTool): GreenlightConfig {
  if (t.name === 'blog') throw new Error('"blog" is a reserved name');
  const entry = {
    name: t.name,
    lane: t.lane,
    target: t.target,
    data: t.data ?? 'none',
    auth: t.auth ?? 'none',
    access: t.access ?? 'public',
    envs: t.envs ?? ['beta', 'prod'],
    ...(t.dir !== undefined ? { dir: t.dir } : {}),
    ...(t.adopted ? { adopted: true } : {}),
    ...(t.external ? { external: true } : {}),
    ...(t.port !== undefined ? { port: t.port } : {}),
    ...(t.preview ? { preview: t.preview } : {}),
    ...(t.tokens?.length ? { tokens: t.tokens } : {}),
    ...(t.tokenOverrides && Object.keys(t.tokenOverrides).length
      ? { tokenOverrides: t.tokenOverrides }
      : {}),
  };
  const tools = config.tools.some((x) => x.name === t.name)
    ? config.tools.map((x) => (x.name === t.name ? entry : x))
    : [...config.tools, entry];
  const result = ConfigSchema.safeParse({ ...config, tools });
  if (!result.success) {
    throw new Error(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

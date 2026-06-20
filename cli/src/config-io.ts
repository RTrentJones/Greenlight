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

import type { Adapter } from '@rtrentjones/greenlight-adapters';
import type { DeployEnv } from '@rtrentjones/greenlight-shared';
import { type VerifyReport, type VerifySpec, verify } from '@rtrentjones/greenlight-verify';

/**
 * One turn of the loop: build → deploy → verify (greenlight-v1.md §11).
 * `verify` targets the deterministic deploy URL — no log scraping. The same
 * orchestration runs locally, in CI, and from the agent.
 */
export interface LoopInput {
  adapter: Adapter;
  toolDir: string;
  env: DeployEnv;
  spec: VerifySpec;
  /** Appended to the deploy URL before verifying (e.g. `/mcp` for the mcp lane). */
  connectPath?: string;
}

export interface LoopResult {
  url: string;
  report: VerifyReport;
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  await input.adapter.build(input.toolDir, input.env);
  const { url } = await input.adapter.deploy(input.toolDir, input.env);
  const verifyUrl = url + (input.connectPath ?? '');
  const report = await verify(verifyUrl, input.spec);
  return { url: verifyUrl, report };
}

/**
 * The git tag the generated Terraform pins its `source = "git::…//infra/modules/*?ref=…"`
 * to. Keep this in lockstep with the published module tag (bump when tagging a release).
 * One source so `add`, `adopt`, and any future emitter agree.
 */
export const MODULE_REF = 'v0.5.0';

/** Base of the git source URL for the framework's Terraform modules. */
export const MODULE_SOURCE_BASE =
  'git::https://github.com/RTrentJones/greenlight.git//infra/modules';

/** Full `source = …` value for a module at the pinned ref. */
export function moduleSource(module: string, ref: string = MODULE_REF): string {
  return `${MODULE_SOURCE_BASE}/${module}?ref=${ref}`;
}

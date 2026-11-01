/** The secret detector moved to `packages/shared/src/redact.ts` (vision 11 §6 names it there, and
 * gate packages may import shared but not wiki). This file keeps the `./redact` import path working
 * inside the wiki package without going through the package index. */
export {
  findSecrets,
  isCodeExpression,
  MIN_VALUE_LENGTH,
  redact,
  type SecretFinding,
} from '@rtrentjones/greenlight-shared';

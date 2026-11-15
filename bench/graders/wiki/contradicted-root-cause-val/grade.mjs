import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeMaintainer, loadRubric } from '../../_lib/maintainer.mjs';

const rubric = loadRubric(dirname(fileURLToPath(import.meta.url)));

export default async (ctx) => gradeMaintainer(ctx, rubric);

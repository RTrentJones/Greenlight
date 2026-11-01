# 17 — Appendix: the WikiSkill paper and how Greenlight uses it

**Source.** Liyan Tang, Cyrus Rashtchian, Chun-Sung Ferng, Andrew Tomkins, Da-Cheng Juan and Tu Vu,
*WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution*,
arXiv:2608.27454v1 (cs.AI, cross-listed cs.CL), 27 August 2026, CC BY 4.0. The authors are at
Google Research, and Tu Vu is also at Virginia Tech.

The full HTML text is at https://arxiv.org/html/2608.27454v1.

> **Limitation: read this before relying on anything in §1.**
>
> - **How this summary was produced.** It comes from a model-extracted reading of the abstract page
>   and the HTML. The PDF returned no extractable text. The prompt details in Appendix E and the
>   steps of Algorithm 1 are paraphrases, not quotations, and the reference list was not read.
> - **The review could not check it.** The owner's independent review of this pack could not
>   retrieve the paper at all, because both the PDF and the HTML were blocked in that environment.
>   Its fidelity to the original is therefore **unverified**.
> - **What follows from that.** Treat the paper's research claims, and every vendor product
>   availability statement elsewhere in this pack, as evidence to check. None of them is a
>   prerequisite that dictates Greenlight's architecture.
>   - Each mechanism Greenlight adopts is justified by Greenlight's own incidents and evaluated by
>     its own gate (06).
>   - The paper is the source of the method's shape: raw layer, wiki, maintainer, proposer, gate and
>     ledger. It is not the source of any guarantee.
> - **Required before M2.** The numbers in §1.6 MUST be checked against the paper before they are
>   quoted outside this repo, and this note updated with the result.

## 1. Summary

### 1.1 Problem and idea

Earlier skill-evolution methods (EvoSkill, Trace2Skill and SkillOpt) revise skills from execution
traces. In the paper's words, they "do not maintain what has been learned as a separate, evolving
knowledge representation." WikiSkill adds that representation, drawing on Karpathy's "LLM Wiki"
idea of "compiling experience into persistent, compounding knowledge." The abstract states the
design as follows: it "separates raw execution experience, accumulated knowledge, and executable
skills, while continuously consolidating experience into the wiki, which subsequent skill updates
can build on."

The setting is offline and iterative. Evolution starts with an empty skill set and an empty wiki,
uses train, validation and test splits, and optimizes the test score. Skills are injected in full
into the inference agent's system prompt, and retrieval is not studied.

### 1.2 Three layers

- **Raw layer (`raw/`).** Execution traces: reasoning, tool calls, tool outputs and final answers.
  "To preserve the raw history, this layer is immutable."
- **Wiki layer (`wiki/`).** It "compiles raw traces into structured, compounding knowledge and is
  maintained throughout skill evolution." It contains:
  - `patterns/`, one markdown file per failure mode or successful strategy, with actionable
    workarounds;
  - `index.md`, a catalog whose entries have the form `[pattern-name](wiki/patterns/pattern-name.md)`
    followed by problem, root cause and fix;
  - `logs.md`, a chronological log;
  - `skill-impact.md`, an audit trail that the outer-loop harness writes after validation. Each
    entry holds proposal metadata, the target skill, a unified diff, the validation score and
    Accepted or Rejected.
- **Skills layer (`skills/`).** Each skill directory has `SKILL.md`, which holds the full skill,
  with name and description frontmatter, instructions and applicability conditions including
  "When to Apply" and "When NOT to Apply". It also has `PURPOSE.md`, which "maps the skill back to
  the motivating Wiki patterns."

### 1.3 Four components and the algorithm

The four components are the Inference Agent, the Wiki Maintainer, the Skill Proposer, and Gating
and Rollback. Algorithm 1, paraphrased:

1. Run a baseline validation pass with the empty skill set to obtain `R_best`. Stop if
   `R_best = 1.0`.
2. Roll out the inference agent on training tasks with the current skills. It has no wiki access
   during these rollouts.
3. Sample traces: up to 8 per iteration, at most 5 failing and up to 3 passing, each truncated to
   15,000 characters. The maintainer consolidates them, together with the full current wiki, into
   W′ₖ.
4. The proposer reads the index, `skill-impact.md` and a summary of training outcomes. It then
   inspects pattern pages and traces on demand in a ReAct loop, and proposes exactly one atomic
   change: create one skill, or patch one existing skill.
5. Apply the change to obtain S′ₖ and evaluate it on validation.
6. Accept the change only on strict improvement (Eq. 4): Sₖ = S′ₖ if R(T_val,k) > R_best, otherwise
   Sₖ₋₁. Rejection reverts the skills only. "The wiki Wₖ is never rolled back regardless of the
   acceptance decision."
7. The harness appends the outcome to `skill-impact.md`.

### 1.4 Maintainer

The maintainer performs "root cause analysis on the failing tasks, and extracts successful
strategies from the passing tasks." "There is no hard limit on the number of patterns created or
updated per iteration." It edits incrementally ("appending, replacing, or inserting text spans")
and rewrites `index.md` and appends to `logs.md` whenever patterns change. Quoted prompt lines:

- "You are a Wiki Maintainer Agent for an LLM skill evolution system."
- "You must perform DEEP ANALYSIS of execution logs to identify root causes, not just
  surface-level symptoms."
- "\"update_index\" and \"append_log\" are REQUIRED. Always provide them, even if there are no new
  patterns."

Pattern pages "should be short (10 to 30 lines)" and cover both failures and successes.

The output JSON has four fields:

- `create_patterns`: name and full content;
- `update_patterns`: name and patch operations, which are `append`, `replace` and `insert_after`,
  with exact-substring targets;
- `update_index`: always the full index;
- `append_log`.

### 1.5 Proposer

The proposer has two tools, `read_file(path)` and `finish(proposal)`. Quoted lines:

- "Read the wiki FIRST -- don't propose something that was already tried and rejected."
- "You MUST read at least 4 execution traces before proposing a skill change."

Its order of work is the index, then `skill-impact` (rejected proposals included), then the
relevant patterns, then the traces of failed tasks. It prefers patching to creating when an
existing skill is partly right.

`finish` takes one of three forms:

- `{action:"create", name, skill_md, purpose_md}`;
- `{action:"patch", name, edits}`;
- `{action:"no_action"}`.

Trace paths of the form `traces/<task_id>` map to the raw layer. The paper gives the proposer
on-demand trace access rather than a fixed sample "to avoid context window exhaustion."

### 1.6 Evaluation

The evaluation covers five benchmarks: LiveMathematicianBench, SealQA, SpreadsheetBench, OfficeQA
and ALFWorld. It uses five models: Gemini-3.5-Flash, Qwen-3.5-4B, Qwen-3.5-9B, Qwen-3.6-27B and
Gemma-4-31B. The baselines are Trace2Skill, EvoSkill, SkillOpt and no skill. Each method was run
three full times, and significance was tested with a paired bootstrap of 1,000 iterations at
p < 0.05.

Average across the five benchmarks (Table 1):

| model | no skill | best baseline | WikiSkill |
|---|---|---|---|
| Qwen-3.5-4B | 26.2 | 35.2 (SkillOpt) | 38.5 |
| Qwen-3.5-9B | 29.9 | 42.3 (EvoSkill) | 47.4 |
| Qwen-3.6-27B | 39.4 | 53.3 (EvoSkill) | 63.3 |
| Gemma-4-31B | 41.3 | 49.1 (SkillOpt) | 54.9 |
| Gemini-3.5-Flash | 49.5 | 56.1 (EvoSkill) | 68.1 |

The other findings:

- **Gains grow with model size.** Within the Qwen family the gain is +12.3, then +17.5, then +23.9.
  Qwen-3.5-9B with skills (47.4) beats Qwen-3.6-27B without skills (39.4).
- **Proposer wiki access is worth +15.** On Gemini-3.5-Flash, giving the proposer access to the
  wiki raised the average from 48.7 to 63.7.
- **Inference-agent wiki access hurts.** Also giving the *inference agent* wiki access during
  rollouts lowered the average to 60.9. The authors suggest that the agent then solves tasks from
  the wiki rather than from the skills, which makes the traces less informative about the skills.
- **Skills transfer across models, in both directions.** Qwen-3.6-27B's SpreadSheet skills raise
  Qwen-3.5-9B from 24.3 to 50.5. Qwen-3.5-4B's SpreadSheet skills drop Gemini-3.5-Flash from 50.5
  to 18.1. The paper distinguishes discovering procedural knowledge from executing it.
- **Dynamics.** Skills average 45 to 129 lines, and runs create 6.3 to 8.9 patterns on average.
  Between 39% and 52% of accepted updates land in iterations 0 to 1.
- **A case study shows the ledger at work.** In ALFWorld, a rejected proposal in iteration 0 was
  logged. Iteration 1 produced the accepted rule "Never Return an Item to Its Origin Location." A
  later pattern led to the refinement "Each Operation Type ONCE Per Item."

### 1.7 Limitations stated by the authors

- There is no automated pruning of the wiki.
- Skill retrieval is not evaluated, because skills are injected in full.
- Long-horizon tasks are not covered.
- The validation sets are small.
- The strict gate excludes neutral proposals that might enable later gains.
- Optimizer cost per iteration is constant in the training size, at `1 + T_ReAct` calls.

## 2. Mapping to Greenlight

| paper concept | Greenlight realization | departure, and why |
|---|---|---|
| raw layer, immutable traces | `RawRecord` in `.greenlight/raw/`, plus Tracer (08 §5) | **By reference.** Greenlight's evidence lives in GitHub issues, PRs, CI runs and Tracer, and accumulates over weeks. Records hold pinned refs and a redacted 15k excerpt instead of full traces (ADR-08). |
| one trace = one task rollout | three time scales joined on `(tool, gitSha)`: build, deploy, run | Incidents span weeks. The keepalive incident ran from July to October across releases. |
| `wiki/patterns`, 10–30 lines | `pattern` pages with the same length rule | **Extra fields:** `atRisk`, `probed`, `catches`, `affects`, `relevance`, `status`. The dominant real failure is a check that measures the wrong layer (15 §2). Version-specific fixes need scoping, and `relevance` keeps app-level lessons visible after the framework defect is fixed. |
| one page type | eight page types, including `fact`, `decision`, `incident`, `contract`, `intent`, `liveness` | Greenlight's existing knowledge already comes in these shapes. Forcing them into one type would bloat patterns. |
| `index.md`, `logs.md` | same, generated and validated (08 §4) | The index is sharded by cell past 60 lines (LR-09), an answer to the growth concern. |
| `skill-impact.md`, harness-written | `ledger.jsonl` rendered to `skill-impact.md`, harness-only (LR-14) | **Generalized into a remediation ledger** with an `outlet` column, because many fixes are not skill text (ADR-01). |
| `PURPOSE.md` maps skill → patterns | `PURPOSE.md` with `cites[]` and the rule text, plus `blast-radius`, `hooks`, `bench-slice` | Lint verifies citations, back-links and coverage (LR-11 to LR-13). |
| skills evolve from an empty set | existing hand-written skills are the starting point | Greenlight already has ten skills encoding real lessons, so starting empty would discard them. |
| outlet: create or patch a skill | five ranked outlets: mechanism, doctor, template, verify, skill | Greenlight's history shows that lessons enforced by code persist and instructions do not (ADR-01). |
| inference agent without wiki access | **two evaluation modes**: isolation (wiki off) for training rollouts and skill attribution, and production (hooks on, pinned wiki snapshot) for the shipped workflow (06 §4.7); in normal use, only `confirmed` patterns, and only after a gate fails (ADR-10) | The ablation concerned trace informativeness during evolution, which isolation mode preserves. The product ships with hooks, so the gate must also check the product as shipped. |
| training traces from rollouts under the current skills | `bench run --split train` under the accepted skill set, regenerated whenever the baseline identity changes and after every merged skill or template change; field records are added as training evidence (06 §1.3) | The earlier draft sampled only existing records, which drift away from the skills being evolved. |
| train / validation / test splits | visibility enforced by mechanism: proposers see train traces and an aggregate val score only; graders, mutants, val/test transcripts are never in a bundle; the proposer runs in a sandbox without a repo checkout (06 §1.4) | Validation is reused across proposals, so leakage would turn the gate into an optimization target. |
| task success graded on the final answer | **behaviour graders** per skill: `app`, `trajectory` (action order from trusted shims), `maintainer`, `routing`, `repro` (06 §4.6), graded in a separate container after the rollout's process tree is killed | A final app passes whether or not the agent previewed before pushing; delivery skills are about order, not only outcome. |
| one acceptance rule | **acceptance by outlet** (06 §5.6): rollouts for skills, generated-app tests for templates, failing-then-passing reproductions for mechanism and doctor, faulty-artifact rejection for verify | A proven framework fix should not need an unrelated capability gain, and a unit test cannot show that instructions change agent behaviour. |
| accept / reject | **ledger stages** recorded separately: `no-action`, `candidate-rejected`, `candidate-accepted`, `merged`, `released`, `verified-in-production`, `withdrawn` (06 §6.1) | A measured candidate is not a shipped fix, and a shipped fix is not a resolved incident. |
| strict improvement rejects neutral proposals (stated limitation) | **safety-fix** and **neutral-prerequisite** paths, both human-reviewed and labelled, replacing efficacy and never safety (06 §5.4) | Replay-only fixes and security repairs must be acceptable when capability is unchanged or saturated. |
| test split reported at the end | **release check** on the held-out test split before any release carrying skill or template changes, and deliberate test-set rotation (06 §4.1, §5.7) | Repeated validation reuse makes val p-values optimistic. |
| evaluation of a fixed setup | content-addressed `BaselineIdentity` and `EvaluationRecord` (06 §1.5, §5.8) | Any change to tasks, graders, dependencies, harness, agent, model, mode or wiki snapshot invalidates the baseline. Decisions are recomputable from stored per-task, per-run outcomes. |
| evolution as a research loop | **the method that drives Greenlight's own improvements from the first milestone** (06 §0, ADR-14); a valid iteration that ends in rejection or `no_action` counts as success | Bringing the cycle forward prevents the roadmap from designing every improvement before the method that is meant to choose them exists. |
| Wiki Maintainer JSON | `MaintainerOutput` with `create_pages` / `update_pages` (08 §9.1) | Generalized from patterns to all page types. The same exact-substring patch ops are kept, with atomic rejection. |
| Skill Proposer, `finish()` | `ProposerOutput` with `create` / `patch` / `issue` / `no_action` (08 §9.2) | The `issue` action routes mechanism, doctor and verify outlets to human-reviewed PRs. |
| validation benchmark | bench of capability briefs plus **replay tasks** from confirmed incidents (06 §4) | Greenlight has no external benchmark, so it builds one from its own failures. |
| graders trusted | every grader must fail on its known-bad mutants (06 §4.3) | The dominant failure class, a check that passes for the wrong reason, applies to graders too. |
| strict improvement gate | **lexicographic gate**: replay safety on both models at every blast radius, then strict improvement in isolation mode, then production-mode non-regression; one policy table (06 §5.4, ADR-11) | Prevents a capability gain from reintroducing a known incident. The two models answer the negative-transfer finding. |
| skills injected in full | progressive disclosure through the agent's skill routing, plus `wiki lookup` keyed by failing check id | An answer to the paper's open retrieval question that needs no semantic search. |
| no pruning | `affects`/`relevance` scoping, archival rules and fact expiry (04 §8) | The paper names this as missing. |
| single operator, offline | offline batch evolution in the framework repo; project wikis grow online through skills' hooks | Project knowledge such as intent and liveness must be written as work happens, not compiled later. |
| one model family per run | ledger records models; monthly re-run on current defaults | Default models change under the skills. Muse's Gemini default has already rotated. |

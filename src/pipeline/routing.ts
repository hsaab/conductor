/**
 * Skill routing for conductor build/verify/remediation agents.
 * Maps planner task kinds to compound child skills and formats the
 * routing decision comment posted to Linear.
 */
import { markers } from "../config.js";
import type { PlannedTask, TaskKind } from "./planner.js";

export interface SkillRoute {
  skill: string;
  why: string;
}

/** Maps a planner task kind to the compound child skill and default rationale. */
export function routeForKind(kind: TaskKind): SkillRoute {
  switch (kind) {
    case "bug":
      return {
        skill: "fix-bug",
        why: "defect or regression — minimal targeted fix with a regression test",
      };
    case "test":
      return {
        skill: "add-tests",
        why: "test coverage — add or migrate tests without changing product behavior",
      };
    case "feature":
    default:
      return {
        skill: "build-feature",
        why: "new or extended functionality — plan if substantial, implement in vertical slices",
      };
  }
}

/** Verbatim fallback guidance when route-task is absent (e.g. server repo). */
function fallbackGuidance(kind: TaskKind): string {
  switch (kind) {
    case "bug":
      return [
        "This is a BUG task. Reproduce the defect, read relevant logs and errors, and make the smallest",
        "targeted change that resolves it. Add a regression test. Then use `ship-task`.",
      ].join(" ");
    case "test":
      return [
        "This is a TEST task. Prioritize test coverage and test infrastructure:",
        "add or migrate the highest-value tests for the described behavior, keep them",
        "fast (no network or DB), and do not change product behavior. Then use `ship-task`.",
      ].join(" ");
    case "feature":
    default:
      return [
        "This is a FEATURE task. Plan if substantial, implement in vertical slices,",
        "add the highest-value tests, then use `ship-task`.",
      ].join(" ");
  }
}

/**
 * Prompt guidance for a build agent: enter through route-task with the planner
 * kind as a strong hint, falling back to direct guidance when the skill is absent.
 */
export function routeGuidance(task: PlannedTask): string {
  const route = routeForKind(task.kind);
  const reason = task.reason?.trim() || route.why;
  return [
    "Enter through the `route-task` skill in this repo.",
    `The planner classified this task as kind=${task.kind} — treat it as a strong hint (expected child skill: \`${route.skill}\` — ${reason}).`,
    "Read and follow `route-task`, then the chosen child skill end to end.",
    `If \`route-task\` is not present in this repo, follow this guidance directly: ${fallbackGuidance(task.kind)}`,
  ].join(" ");
}

/** One line per planned task for the Linear routing comment. */
function routingLine(task: PlannedTask): string {
  const route = routeForKind(task.kind);
  const reason = task.reason?.trim() || route.why;
  return `- \`${task.repo}\` → \`${route.skill}\` (${task.kind}) — ${reason}`;
}

/** Human-readable + machine-parseable routing comment for the Linear thread. */
export function routingCommentBody(tasks: PlannedTask[]): string {
  const lines = tasks.map(routingLine).join("\n");
  return `${markers.routing}
${markers.bridge}
**🧭 Routing decision**

${lines}`;
}

/** Skill entry line for verify/remediation prompts. */
export function skillEntryLine(skill: string): string {
  return `Enter through the \`${skill}\` skill in this repo if present; otherwise follow the steps below.`;
}

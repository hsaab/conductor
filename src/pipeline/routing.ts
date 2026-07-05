/**
 * Skill routing for conductor build/verify/remediation agents.
 *
 * Routing is the agent's decision, not conductor's: the planner agent chooses a
 * child skill per task (see `planner.ts`), and every build agent enters through
 * the repo's `route-task` skill, which owns the final routing. This module only
 * *carries* the planner's suggestion into the build prompt and formats the
 * routing decision comment posted to Linear — there is no deterministic
 * kind→skill mapping here.
 */
import { markers } from "../config.js";
import type { PlannedTask } from "./planner.js";

/**
 * Prompt guidance for a build agent: always enter through `route-task` and let
 * it own routing. When the planner already chose a child skill we pass it as a
 * suggestion; when it did not (fallback plan), route-task selects the skill.
 */
export function routeGuidance(task: PlannedTask): string {
  const lines = ["Enter through the `route-task` skill in this repo and read it."];
  if (task.skill) {
    const reason = task.reason?.trim();
    lines.push(
      `The planner suggests \`${task.skill}\` as the child skill for this task${reason ? ` (${reason})` : ""} — use it unless route-task's own routing clearly points elsewhere.`,
    );
  } else {
    lines.push("Follow route-task to select the child skill that best fits this task.");
  }
  lines.push("Then read and follow the chosen child skill end to end.");
  lines.push(
    `If \`route-task\` is not present in this repo${task.skill ? ` and neither is \`${task.skill}\`` : ""}, implement the task directly from the instructions below and open a PR.`,
  );
  return lines.join(" ");
}

/** One line per planned task for the Linear routing comment. */
function routingLine(task: PlannedTask): string {
  const skill = task.skill ?? "route-task";
  const detail =
    task.reason?.trim() ||
    (task.skill ? "planner-selected child skill" : "agent selects the child skill via route-task");
  return `- \`${task.repo}\` → \`${skill}\` (${task.kind}) — ${detail}`;
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

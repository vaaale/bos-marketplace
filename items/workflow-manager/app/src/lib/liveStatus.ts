// liveStatus.ts — per-step status for the graph.
//
// The service now owns ONE live projection (services/engine/run-state.js) and
// returns it populated from the very first poll — `steps` is authoritative
// for a live run as well as a finished one (FR-036). So the normal path here
// is simply "use run.steps".
//
// The event replay below is kept as a FALLBACK for the older service contract
// (which only assigned `steps` after the run settled, leaving `steps: {}` for
// the whole duration of a run) so a newer app bundle installed against an
// older service build still colors the graph correctly.
import type { RunEvent, StepState } from "./types";

export function deriveLiveSteps(events: RunEvent[]): Record<string, StepState> {
  const steps: Record<string, StepState> = {};
  for (const ev of events) {
    if (!ev.stepId) continue;
    switch (ev.type) {
      case "step.start":
        steps[ev.stepId] = { status: "running", attempt: ev.attempt, attempts: ev.attempt };
        break;
      case "step.retry":
        steps[ev.stepId] = { status: "running", attempt: ev.attempt, attempts: ev.attempt, error: ev.error };
        break;
      case "step.complete":
        steps[ev.stepId] = { status: "completed", attempt: ev.attempt, attempts: ev.attempt };
        break;
      case "step.skip":
        steps[ev.stepId] = { status: "skipped", reason: ev.reason };
        break;
      case "step.fail":
        steps[ev.stepId] =
          ev.error === "cancelled"
            ? { status: "cancelled", attempt: ev.attempt, attempts: ev.attempt }
            : { status: "failed", attempt: ev.attempt, attempts: ev.attempt, error: ev.error };
        break;
      default:
        break;
    }
  }
  return steps;
}

interface RunLike {
  state?: string;
  steps?: Record<string, StepState>;
  events?: RunEvent[];
}

/** The service's own per-step map when it has one; the replayed log otherwise. */
export function liveStepsFor(run: RunLike | null | undefined): Record<string, StepState> {
  if (!run) return {};
  if (run.steps && Object.keys(run.steps).length > 0) return run.steps;
  return deriveLiveSteps(run.events || []);
}

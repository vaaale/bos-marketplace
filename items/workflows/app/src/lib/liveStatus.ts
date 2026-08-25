// liveStatus.ts — derives per-step live status from a run's event stream.
//
// The service (services/runs.js `startRun`) only assigns the authoritative
// `steps` map once the whole run settles — `live.steps = result.steps` runs
// after `runWorkflow()` resolves. While a run is `"running"`, `steps` is
// still `{}` on every poll; `events` is the only field that updates as each
// step starts/completes/retries/fails (scheduler.js calls `emit()`
// synchronously for each). So for a live run we replay events instead of
// trusting `steps`; once the run is terminal, `steps` is authoritative and
// matches the persisted run log exactly (including "neutral" for steps that
// never ran), so we prefer it.
import type { RunEvent, StepState } from "./types";

export function deriveLiveSteps(events: RunEvent[]): Record<string, StepState> {
  const steps: Record<string, StepState> = {};
  for (const ev of events) {
    if (!ev.stepId) continue;
    switch (ev.type) {
      case "step.start":
        steps[ev.stepId] = { status: "running", attempts: ev.attempt };
        break;
      case "step.retry":
        steps[ev.stepId] = { status: "running", attempts: ev.attempt, error: ev.error };
        break;
      case "step.complete":
        steps[ev.stepId] = { status: "completed", attempts: ev.attempt };
        break;
      case "step.fail":
        steps[ev.stepId] =
          ev.error === "cancelled"
            ? { status: "cancelled", attempts: ev.attempt }
            : { status: "failed", attempts: ev.attempt, error: ev.error };
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

/** Live (event-derived) while running; authoritative persisted `steps` once settled. */
export function liveStepsFor(run: RunLike | null | undefined): Record<string, StepState> {
  if (!run) return {};
  if (run.state !== "running" && run.steps && Object.keys(run.steps).length > 0) return run.steps;
  return deriveLiveSteps(run.events || []);
}

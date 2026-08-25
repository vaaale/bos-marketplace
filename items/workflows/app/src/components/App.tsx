import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Workflow, WorkflowListEntry } from "../lib/types";
import { api, getServiceRunning } from "../lib/bridge";
import { ServiceStatusPill } from "./StatusPill";
import { StoppedBanner } from "./StoppedBanner";
import { ListView } from "./ListView";
import { DetailView } from "./DetailView";
import { RunView } from "./RunView";

type View = "list" | "detail" | "run";

const SERVICE_POLL_MS = 5000;
const LIST_POLL_MS = 4000;

export function App() {
  const [view, setView] = useState<View>("list");
  const [serviceRunning, setServiceRunning] = useState<boolean | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowListEntry[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [currentWorkflow, setCurrentWorkflow] = useState<Workflow | null>(null);
  const [currentStatus, setCurrentStatus] = useState<string>("idle");
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const list = (await api.list()) as WorkflowListEntry[];
      setWorkflows(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Service status pill + stopped banner (poll — the app has no push channel to the service).
  useEffect(() => {
    let stopped = false;
    async function poll() {
      const running = await getServiceRunning();
      if (!stopped) setServiceRunning(running);
    }
    void poll();
    const t = setInterval(poll, SERVICE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  // List view auto-refresh (also picks up run_id/status changes for FR-024 polling).
  useEffect(() => {
    if (view !== "list") return;
    void refreshList();
    const t = setInterval(refreshList, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [view, refreshList]);

  // Detail view: keep the live status pill current.
  useEffect(() => {
    if (view !== "detail" || !currentWorkflow) return;
    let stopped = false;
    async function poll() {
      try {
        const status = (await api.status(currentWorkflow!.id)) as { state?: string; running?: boolean };
        if (!stopped) setCurrentStatus(status.running ? "running" : status.state || "idle");
      } catch {
        // ignore transient errors
      }
    }
    void poll();
    const t = setInterval(poll, LIST_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [view, currentWorkflow]);

  async function openWorkflow(id: string) {
    try {
      const wf = (await api.read(id)) as Workflow;
      setCurrentWorkflow(wf);
      setCurrentStatus("idle");
      setView("detail");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function runWorkflow(id: string) {
    try {
      const { runId } = (await api.run(id)) as { runId: string };
      if (!currentWorkflow || currentWorkflow.id !== id) {
        const wf = (await api.read(id)) as Workflow;
        setCurrentWorkflow(wf);
      }
      setCurrentRunId(runId);
      setView("run");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function cancelWorkflow(id: string) {
    try {
      await api.cancel(id);
      void refreshList();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function watchRun(id: string, runId: string) {
    try {
      if (!currentWorkflow || currentWorkflow.id !== id) {
        const wf = (await api.read(id)) as Workflow;
        setCurrentWorkflow(wf);
      }
      setCurrentRunId(runId);
      setView("run");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function createWorkflow(taskDescription: string) {
    try {
      await api.create({ taskDescription });
      await refreshList();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  }

  async function reloadCurrentWorkflow(id: string) {
    try {
      const wf = (await api.read(id)) as Workflow;
      setCurrentWorkflow(wf);
      void refreshList();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteWorkflow(id: string) {
    try {
      await api.delete(id);
      setView("list");
      setCurrentWorkflow(null);
      await refreshList();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="wf-app">
      <div className="wf-toolbar">
        <div className="wf-brand">
          <span className="wf-brand-icon">⌗</span>
          <span style={{ fontWeight: 600 }}>Workflow Manager</span>
        </div>
        <ServiceStatusPill running={serviceRunning} />
        <div style={{ flex: 1 }} />
        <button className="wf-btn wf-btn-sm" onClick={() => refreshList()} title="Refresh /Workflows">
          ↻ Refresh <span className="wf-tool-label">workflow_status</span>
        </button>
      </div>

      {serviceRunning === false ? <StoppedBanner /> : null}
      {error ? (
        <div className="wf-error-banner" onClick={() => setError(null)}>
          {error} (click to dismiss)
        </div>
      ) : null}

      <div className="wf-body">
        {view === "list" ? (
          <ListView
            workflows={workflows}
            loading={loadingList}
            onOpen={openWorkflow}
            onRun={runWorkflow}
            onCancel={cancelWorkflow}
            onCreate={createWorkflow}
            onWatchRun={watchRun}
            onEdit={openWorkflow}
          />
        ) : null}

        {view === "detail" && currentWorkflow ? (
          <DetailView
            workflow={currentWorkflow}
            liveStatus={currentStatus}
            onBack={() => setView("list")}
            onRun={() => runWorkflow(currentWorkflow.id)}
            onCancel={() => cancelWorkflow(currentWorkflow.id)}
            onDelete={() => deleteWorkflow(currentWorkflow.id)}
            onWatchRun={(runId) => watchRun(currentWorkflow.id, runId)}
            onModified={() => reloadCurrentWorkflow(currentWorkflow.id)}
          />
        ) : null}

        {view === "run" && currentWorkflow && currentRunId ? (
          <RunView workflow={currentWorkflow} runId={currentRunId} onBack={() => setView("detail")} />
        ) : null}
      </div>
    </div>
  );
}

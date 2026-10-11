// App.tsx — the standalone master-detail app shell (FR-035): titlebar +
// the Overview / Jobs / Query tab bar with a live Jobs badge, exactly as the
// binding mockup lays it out. This is a dock-openable app, not a settings
// config page.
//
// The three tabs share one state root so that, e.g., ingesting from Overview
// immediately bumps the Jobs badge, and the bundle you opened in Overview is
// the bundle Query starts on.

import React from "react";
import { Icon } from "./lib/icons";
import { fetchBundles, fetchJobs, fetchTools, ServiceOfflineError } from "./lib/serviceClient";
import type { BundleHealth, Job } from "./lib/types";
import Overview from "./overview/Overview";
import JobsTab from "./jobs/JobsTab";
import QueryTab from "./query/QueryTab";

export type AppTab = "overview" | "jobs" | "query";

/** Jobs poll interval. The mockup shows a live elapsed time and a progress
 *  bar; the service exposes jobs over plain HTTP (polling, not SSE, matches
 *  the loopback bridge — design.md §8.3). 3 s is fast enough for the run
 *  lifecycle to read as live without hammering a loopback port. */
const JOBS_POLL_MS = 3000;

export default function App() {
  const [tab, setTab] = React.useState<AppTab>("overview");
  const [bundles, setBundles] = React.useState<BundleHealth[]>([]);
  const [jobs, setJobs] = React.useState<Job[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [activeBundle, setActiveBundle] = React.useState<string | null>(null);
  const [toolCount, setToolCount] = React.useState<number | null>(null);

  const reloadBundles = React.useCallback(async () => {
    try {
      const data = await fetchBundles();
      setBundles(data.bundles);
      setError(null);
      setActiveBundle((cur) => cur ?? (data.bundles.length ? data.bundles[0].name : null));
    } catch (e) {
      setError(
        e instanceof ServiceOfflineError
          ? e.message
          : `Could not reach the OKF Knowledge Base service: ${(e as Error).message}. Check it is running in Settings → Plugins.`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reloadBundles();
    // the badge reports what the service actually declares
    fetchTools()
      .then((t) => setToolCount(t.count))
      .catch(() => setToolCount(null));
  }, [reloadBundles]);

  // The badge is live on EVERY tab (FR-041: "the app must reflect a run's
  // status as it changes") — not only while the Jobs tab is open, or a run
  // started from Overview would look like nothing happened.
  const reloadJobs = React.useCallback(async () => {
    try {
      const data = await fetchJobs();
      setJobs(data.jobs);
    } catch {
      /* a transient bridge hiccup must not blank the UI */
    }
  }, []);

  React.useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await reloadJobs();
    };
    void tick();
    const timer = setInterval(tick, JOBS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [reloadJobs]);

  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  const TABS: { id: AppTab; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "book" },
    { id: "jobs", label: "Jobs", icon: "zap" },
    { id: "query", label: "Query", icon: "graph" },
  ];

  return (
    <div className="app" data-testid="okf-app">
      <header className="titlebar">
        <div className="tb-left">
          <span className="glyph">🧠</span>
          <div>
            <div className="tb-title">OKF Knowledge Base</div>
            <div className="tb-sub">
              Open Knowledge Format bundles · concept-anchored, chapter-granular retrieval
            </div>
          </div>
        </div>
        <div className="tb-right">
          <span className="badge" data-testid="tool-badge">
            standalone app{toolCount === null ? "" : ` · ${toolCount} okf_* tools`}
          </span>
          <button className="ibtn" title="Refresh" onClick={() => void reloadBundles()} data-testid="refresh-btn">
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>

      <nav className="tabbar" data-testid="tabbar">
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`app-tab${tab === t.id ? " active" : ""}`}
            data-app={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
            {/* every run on record, cancelled ones included — the badge is
                "how many runs are listed", not "how many went well". */}
            {t.id === "jobs" && jobs.length > 0 ? (
              <span className="app-tab-cnt" data-testid="jobs-badge">
                {jobs.length}
              </span>
            ) : null}
          </div>
        ))}
      </nav>

      <div className="app-main">
        {error ? (
          <div className="app-view">
            <div className="app-error" data-testid="service-error">
              <b>Service unreachable.</b> {error}
            </div>
          </div>
        ) : loading ? (
          <div className="app-view">
            <div className="app-loading">Connecting to the OKF Knowledge Base service…</div>
          </div>
        ) : null}

        <section className={`app-view${tab === "overview" ? "" : " hidden"}`} data-testid="view-overview">
          <Overview
            bundles={bundles}
            activeBundle={activeBundle}
            onActiveBundle={setActiveBundle}
            onBundlesChanged={reloadBundles}
          />
        </section>

        <section className={`app-view${tab === "jobs" ? "" : " hidden"}`} data-testid="view-jobs">
          {/* onJobsChanged re-polls immediately after a Cancel or a Delete,
              so the row reflects the service's answer at once instead of
              lagging up to a whole poll interval behind the click. */}
          <JobsTab jobs={jobs} activeJobs={activeJobs} onJobsChanged={() => void reloadJobs()} />
        </section>

        {/* The Query tab mounts only while visible: its force simulation sizes
            its viewBox from the REAL container dimensions, which are 0 while
            the pane is display:none. */}
        <section className={`app-view${tab === "query" ? "" : " hidden"}`} id="app-query" data-testid="view-query">
          {tab === "query" ? (
            <QueryTab bundles={bundles} bundle={activeBundle} onBundle={setActiveBundle} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

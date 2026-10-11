# Tool surface

**Superseded — see [tool-surface.md](tool-surface.md).**

This file described an earlier 18-tool surface. The service now declares **21** `okf_*` tools, including the job-control pair `okf_cancel_job` / `okf_delete_job`, and `tool-surface.md` is the single document that tracks them.

The authority above both is the service itself: `GET /tools` on its loopback port returns the list exactly as it is declared, which is what the app's titlebar badge and the e2e count assertion read.

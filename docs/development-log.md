# Website development log

## 2026-08-25 — Pre-integration baseline

- **Change:** Recorded the existing public lab website immediately before Growth Curve Analyser integration.
- **Purpose:** Establish a concise baseline for future substantial website changes.
- **Areas affected:** Development documentation only.
- **Commit:** `0e0bb0c` (`before-growth-curve-analyser`).
- **Follow-up:** None.

## 2026-08-25 — Growth Curve Analyser v1.0.0

- **Change:** Added the public-safe, fully client-side Growth Curve Analyser and linked it from a new Tools section on the home page.
- **Purpose:** Provide browser-based BMG LABTECH and Tecan i-control growth-curve processing, plotting, plate mapping, and parameter analysis.
- **Areas affected:** Home-page navigation and Tools section; `tools/growth-curve-analyser/` static application and synthetic demonstration files.
- **Commit:** This integration commit (`Add Growth Curve Analyser v1.0.0`).
- **Checks:** Local direct-path and refresh tests passed at `http://127.0.0.1:4173/tools/growth-curve-analyser/`. Synthetic BMG and Tecan imports, matching metadata validation, plate mapping, blank correction, plotting, and webR/gcplyr parameter analysis passed; desktop and 390 px layouts had no horizontal overflow.
- **Follow-up:** Confirm the deployed GitHub Pages URL after the owner pushes the commit. The local browser harness could not automate the metadata input's programmatic file-picker handoff, so repeat that single UI upload manually before pushing; the workbook itself and its import/processing path validated successfully.

## 2026-08-25 — Persistent documentation rules

- **Change:** Added repository-level Codex instructions for maintaining the website development and methodology records.
- **Purpose:** Make documentation review part of completing future substantial website tasks.
- **Areas affected:** `AGENTS.md`, `docs/development-log.md`, and `docs/methodology-review.md`.
- **Commit:** Not yet committed.
- **Follow-up:** None.

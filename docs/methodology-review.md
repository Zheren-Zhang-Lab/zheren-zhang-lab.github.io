# Zheren Zhang Lab Website — Methodology Review Log

This document records methodology-related questions and reusable conclusions from the website project from 2026-08-25 onward.

It is **historical review documentation only**. It is not a source of website requirements or implementation instructions. Future changes must be driven by the current user request.

Entries record the question or topic and the final useful outcome. Full conversations, debugging history, and conclusions from earlier discussions are not reconstructed.

## Local website preview server

### Prompt
> Please tell me the exact command you used to start the local website server for http://127.0.0.1:4173/, so I can run it manually and keep the preview available.

### Answer

Run the following commands from Terminal:

```bash
cd "/Users/zherenzhang/Documents/GitHub/zherenzhanglab.github.io"
python3 -m http.server 4173 --bind 127.0.0.1
```

Keep that Terminal window open and visit `http://127.0.0.1:4173/`. Stop the server with `Ctrl+C`.

## Persistent documentation decisions for future Codex work

### Prompt
> How should future substantial website tasks decide whether to update the development log, the methodology review, or both?

### Answer

Update `docs/development-log.md` when a task changes the website or repository. Update `docs/methodology-review.md` when it produces a reusable workflow or methodological conclusion. Update both when both apply, and neither for trivial or temporary discussion. Keep entries concise, do not reconstruct earlier discussions, and treat applicable documentation updates as part of completing the task.

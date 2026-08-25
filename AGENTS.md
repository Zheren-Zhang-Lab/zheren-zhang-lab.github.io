# Repository instructions

These instructions apply to all future Codex work in this website repository.

## Documentation rules

For every substantial website-related task, decide whether the outcome should be recorded in:

- `docs/development-log.md`
- `docs/methodology-review.md`

### Use `docs/development-log.md` for

- actual website changes;
- new features;
- integrations;
- UI or layout changes;
- dependency or build changes;
- deployment-related changes;
- bug fixes;
- structural changes to the repository;
- important implementation decisions.

Keep each entry concise and factual. Include, where relevant:

- date;
- short description;
- purpose;
- main files or areas affected;
- commit hash when available;
- known follow-up issues.

### Use `docs/methodology-review.md` for

- questions about how the website or project should be developed;
- workflow decisions;
- Git or GitHub practices;
- local testing methods;
- deployment methodology;
- debugging approaches worth remembering;
- explanations or conclusions that may help with future website work.

Each entry should include:

- the question or topic;
- the useful conclusion or outcome;
- only information worth retaining for future reference.

Do not copy full conversations or debugging transcripts.

## Decision rule

At the end of each substantial website-related task:

- update `docs/development-log.md` if the task changed the website or project;
- update `docs/methodology-review.md` if the task produced a reusable workflow or methodological conclusion;
- update both if both are relevant;
- do not update either for trivial or temporary discussion.

Do not reconstruct past discussions unless explicitly asked.

Treat applicable documentation updates as part of completing the task rather than waiting for the user to request them separately.

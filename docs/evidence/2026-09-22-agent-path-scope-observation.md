# Agent tool calls can read outside the project and outside the data root (2026-09-22)

Found while producing the README front-page screenshots on an isolated instance of the release build
(v1.68.0, English UI, `PURESCIENCE_STORAGE_ROOT` pointing at a temp root and `settings.dataRoot` set
inside it). Two real turns in that instance, both asking the agent to read a CSV that had been uploaded
to the project's Files panel.

## What happened

**Turn 1** (prompt: *"Read `egfr_t790m_merged.csv` from this project files panel…"*). The agent's first
move was a filesystem search:

```
Bash · find /private/tmp/<isolated-root> -iname "*egfr*" …; find / -iname "egfr_t790m_merged.csv" -not -path "*/proc/*"
```

The second `find` is unbounded, and it matched a same-named file **outside the isolated data root** — in
the machine's default data root, in another installation's project tree (`<home>/PureScience-DEV/notebooks/
<project-id>/…`, redacted here). The agent read that copy and continued from it.

Integrity check afterwards: nothing under `<home>/PureScience-DEV` had been modified in the preceding 30
minutes (`find <home>/PureScience-DEV -newermt '-30 minutes'` returned nothing), i.e. the exposure was
read-only, and the turn's writes all landed inside the isolated root
(`<isolated-root>/data/PureScience-DEV/notebooks/<project-id>/…`).

**Turn 2** (prompt explicitly scoped: *"Read `kras_g12c_inhibitors.csv` from this project Files panel only
(do not search the filesystem)…"*). The agent still began with shell searches, then tried to read **another
project's** upload tree — and the application denied it. The agent's own next line: *"That denial is fair —
I overreached into other projects' upload trees. Scoping back to this project only:"*. It then completed
the task from the project's own copy and produced `kras_g12c_ic50_ranking.png` (70 KB) plus
`plot_kras_ranking.py`.

## What this means

1. **The project-scope guard works** — a call reaching into a different project's tree is refused, and the
   refusal is legible enough that the agent corrects itself.
2. **The boundary is not enforced for plain shell searches** — `find /` from a shell tool call can read
   paths outside the project and outside the configured data root (in this case another installation's
   project tree, which happened to hold a same-named file). Nothing was written, but a read crossed the
   boundary.
3. **The project file API is not the agent's first instinct** — both turns opened with a filesystem search
   rather than reading the file the user had attached to the project. That is what puts the turn in contact
   with unrelated trees in the first place; the file was reachable the whole time (the Files panel listed
   it, and the turn-2 artifacts were produced from the project's own copy).

## Candidate next-version item

Either constrain shell/read tool calls to the project's materialized workspace plus explicit folder grants
(so an unbounded search fails closed, as cross-project reads already do), or make the project-file read
path the discoverable route so a full-disk search stops being the natural first move. Not a release
blocker and nothing was written outside the root, but it is the difference between "the guard refused it"
and "the search never reached it".

## Repro

- Instance: `PURESCIENCE_WEB_PORT=<port> PURESCIENCE_STORAGE_ROOT=/tmp/<root> npx electron-vite dev --
  --user-data-dir=/tmp/<profile> --remote-debugging-port=<cdp> --disable-gpu` (windowed: the desktop
  channels are Electron-only), `settings.dataRoot=/tmp/<root>/data/PureScience-DEV`, one provider copied
  from a working settings file, `defaultPermissionProfile: auto`.
- Data: `docs/demo-verification/egfr_t790m_merged.csv` and `docs/demo-verification/kras_g12c_inhibitors.csv`
  copied into the temp root and uploaded through `uploads.stageLocalPath`, each to its own project.
- The two prompts above, sent through the real composer.

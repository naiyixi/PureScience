# PureScience CLI

The `purescience` command controls the local PureScience service and submits research tasks without
requiring browser interaction.

## Installation

### From the installed application

Open **Settings > General > Command line tool** in PureScience and choose **Install command**. This
adds an `purescience` launcher to your PATH (`~/.local/bin` on macOS and Linux, or a per-user
directory added to PATH on Windows). The launcher uses the application's bundled runtime, so it does
not require a separate Node.js installation.

If the launcher directory is not yet on PATH, the Settings panel shows the line to add. Open a new
terminal after updating PATH. Choose **Uninstall command** in the same panel to remove the launcher.

### From npm

The npm package requires Node.js 22.5 or later and an installed PureScience desktop application.
Install it globally after the package is published:

```bash
npm install --global @zerolink/purescience
purescience --help
```

### From a source checkout

Replace `purescience` in the examples below with:

```bash
node packages/purescience/cli.mjs
```

## Set up and check your machine

Two commands cover the local side without deciding anything the application decides.

### `purescience init`

Creates the config root if it is missing (mode `0700`) and prints where the CLI keeps its state. It writes
no settings and overwrites no file, so running it against an existing installation is safe.

```bash
purescience init
purescience init --config-root /absolute/path --json
```

### `purescience doctor`

Reports facts measured on this machine — the resolved config root (and whether it can actually be written),
the service state file and whether the pid it records is still alive, whether a web token exists (reported
by length, never by value), whether an installed application binary can be located, and whether the running
Node satisfies the requirement the package itself declares. Every line carries the evidence it came from.

It deliberately does **not** decide whether the machine is ready. That judgement has exactly one
implementation — in the application — and `purescience ready` prints it; a doctor that re-decided would be a
second implementation of the same question, and the two would drift. `doctor` exits `1` when one of its own
checks failed, and `0` otherwise.

```bash
purescience doctor
purescience doctor --json        # for scripts: every check carries {check, status, evidence}
```

## Service lifecycle

Start the service without opening a browser, check its status, or stop it:

```bash
purescience start --no-open
purescience status --json
purescience stop
```

To open the Web UI later, request its authenticated URL explicitly:

```bash
purescience url
```

`purescience url` is the only command that intentionally prints an authenticated browser URL. Normal
human-readable, JSON, and JSONL output never includes the local token.

Use `--port <port>` to override the default port of `44100`. `--app-path <path>` selects a specific
PureScience executable. Development builds also support `--config-root <path>`.

### Linux AppImage sandbox fallback

`purescience start` keeps Chromium sandboxing enabled by default. On some Linux hosts, an AppImage
mounted with `nosuid` cannot use Chromium's SUID sandbox helper; Ubuntu may also restrict
unprivileged user namespaces. In that case the command fails promptly with guidance instead of
waiting for the service timeout.

If the host cannot support sandboxed startup, an explicit rootless fallback is available:

```bash
purescience start --no-sandbox --no-open
```

`--no-sandbox` disables Chromium's process sandbox and reduces security. Use it only when necessary;
the Debian package or a host configuration that supports Chromium sandboxing is preferred.

## Projects

Create a project and list the projects available to task runs:

```bash
purescience project create "Systematic review" --description "Evidence review workspace" --json
purescience project list --json
```

Commands that accept `--project` allow either a project ID or an exact project name.

## Run a task

Provide a prompt directly, read it from a UTF-8 file, or pipe it through stdin:

```bash
purescience run --project "Systematic review" --prompt "Summarize the evidence" --wait
purescience run --project "Systematic review" --prompt-file ./task.md --wait --json
printf '%s\n' "Summarize the evidence" | purescience run --project "Systematic review" --wait --json
```

Without `--wait`, the command returns as soon as the run starts. Use the returned `id` and `sessionId`
to poll its state:

```bash
purescience run --project "Systematic review" --prompt-file ./task.md --json
purescience run status <run-id> --json
purescience session status <session-id> --json
```

Use `--timeout-ms <milliseconds>` with `--wait` to bound how long the client waits. A timeout stops the
CLI wait and returns exit code `1`; it does not cancel the run, which can still be inspected with
`purescience run status <run-id>`. When the `ask` approval profile needs permission, human-readable
output directs the user to approve the request in PureScience Desktop or the Web UI.

Pass an existing session ID to continue a conversation. Approval profiles are `ask`, `auto`, and
`full`; `--skill` is repeatable:

```bash
purescience run \
  --project "Systematic review" \
  --session <session-id> \
  --prompt-file ./follow-up.md \
  --approval-profile auto \
  --skill literature-review \
  --skill citation-check \
  --wait \
  --json
```

The default approval profile is `ask`. Unattended workflows must explicitly use
`--approval-profile auto` or `--approval-profile full` when that access is appropriate.

## Machine-readable output

Use `--json` to emit one result. `--jsonl` requires `run --wait` and emits progress events followed by
the final run object, one JSON value per line:

```bash
purescience run \
  --project "Systematic review" \
  --prompt-file ./task.md \
  --approval-profile auto \
  --wait \
  --jsonl
```

`--json` and `--jsonl` cannot be used together. Structured errors use this shape:

```json
{ "error": { "code": "invalid_cli_usage", "message": "--project is required." }, "exitCode": 2 }
```

Exit codes form part of the automation contract:

| Exit code | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `0`       | The command succeeded, including a completed waited run.      |
| `1`       | A run failed or a general command failure occurred.           |
| `2`       | CLI usage was invalid.                                        |
| `3`       | The local daemon was unavailable.                             |
| `4`       | A requested project, run, session, or artifact was not found. |

Timeouts and `session_busy` conflicts use exit code `1` and retain their distinct `timeout` and
`session_busy` error codes in structured output.

## Artifacts

List the artifacts produced for a session and download one by ID:

```bash
purescience artifacts list <session-id> --json
purescience artifacts download <artifact-id> --output ./report.md --json
```

Artifact output paths are resolved relative to the current working directory.

## Machine state

Read what the application already decided about this machine — the same readiness judgement, runtime
survey and connector list the settings window shows, with nothing re-computed on the command line:

```bash
purescience ready --json
purescience runtime list --json
purescience connectors list --json
```

`ready` prints the environment check (platform support, app storage, credential vault, installation
network, Python for notebooks), each entry with its status and the sentence that explains it. Use it
to tell a failed install from a working one before opening the app.

## Re-running a recorded artifact

Every artifact version records the code that produced it, the inputs it read and a digest of what came
out. `replay` runs that code again — through the same notebook execution the original run used, in a
throwaway directory with the recorded inputs copied in — and compares the result with the recording:

```bash
purescience replay <versionId> --project <projectId> --session <appSessionId> --artifact <artifactId> --json
```

The output keeps three facts apart, and they must stay apart:

- **verdict** — `reproduced` only when every comparable output is byte-identical; `differs` when they are
  not; `unverifiable` when nothing could be concluded (a failed run, a timeout, a missing runtime, or a
  version whose steps came from a model reconstruction rather than from an execution record);
- **origin** — `executed` when the recorded steps come from a real run, `reconstructed` when they were
  inferred by a model. A reconstructed recipe is never executed: running inferred code produces a file
  that looks like evidence and is not;
- **env lock** — `applied` only when the re-run's own environment manifest came back and matches the
  recorded one. `not-applied` means the same code ran without rebuilding the packages: strong evidence,
  and not the same claim.

A version with no recorded code is refused with that reason instead of being re-run from something else.

## Rollback to 0.7.3

The current Session and file formats contain fields that PureScience 0.7.3 cannot safely write.
Replacing only the application binary can therefore discard newer Upload, conversation-branch, and
Artifact provenance data. Prepare a compatible copy before installing 0.7.3:

1. Quit PureScience completely.
2. Run `purescience rollback-to-0.7.3 --yes`.
3. Keep the paths printed by the command, then install and start PureScience 0.7.3.

No pre-upgrade backup is required. The command is offline and does not rewrite the newer data: it
copies Uploads, Artifacts, Notebooks, and workspaces into a new rollback Data Root; converts each
Session's active message branch to the 0.7.3 envelope; moves the newer Config Root to a timestamped
sibling; and activates a converted Config Root at the original location. If the old Config Root and
Data Root share one directory, the preserved newer Data Root moves with that directory. The command
does not copy runtime environments, which 0.7.3 rebuilds.

By default, the rollback Data Root is a timestamped sibling of the current Data Root. Choose another
empty location with `--output`:

```bash
purescience rollback-to-0.7.3 --yes --output /path/to/PureScience-0.7.3
```

Development and recovery workflows can override both source roots explicitly:

```bash
purescience rollback-to-0.7.3 --yes \
  --config-root /path/to/.purescience \
  --data-root /path/to/PureScience \
  --output /path/to/PureScience-0.7.3
```

Use `--json` to print the rollback manifest as one JSON object. The same manifest is written to
`rollback-to-0.7.3.json` in both the activated Config Root and rollback Data Root. It records the
preserved newer Config Root and Data Root paths needed to return to the newer application.
Adjacent durable preparation and cutover markers let the same command clean or finish an interrupted
conversion after a process or power interruption; do not delete timestamped staging or preserved
directories while that recovery runs.

The 0.7.3 copy contains only the active branch of each conversation. Inactive branches, Artifact
version history, reviews, and provenance snapshots remain preserved in the newer roots but are not
visible to 0.7.3. The command refuses to run while PureScience appears active, when a source path is
missing or aliases storage through a symbolic link/junction, when a Version's size or checksum does
not match SQLite, or when a rollback target already exists.

## Current scope

The initial CLI does not expose file or directory attachments, per-run model selection, or per-run
agent-backend selection. These require stable public runtime contracts before they can be added.

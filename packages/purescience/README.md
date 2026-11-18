# purescience

Node.js SDK and command-line client for an PureScience daemon running on the local machine.

## Documentation

- [CLI guide](./CLI.md) - installation, daemon lifecycle, task automation, artifacts, and exit codes

## SDK quick start

```js
import { connectToPureScience } from 'purescience'

const client = await connectToPureScience()
const run = await client.startRun({
  project: 'systematic-review',
  prompt: 'Summarize the evidence.',
  permissionProfile: 'auto'
})
const result = await client.waitForRun(run.id)
console.log(result.output)
```

The client discovers the local daemon and reads its authentication token from the PureScience config
directory. Tokens are sent in request headers and are never included in normal command output.
Discovery reads the `web-service.json` a serving instance publishes; an instance that never published one
is reachable only by constructing `new PureScienceClient({ baseUrl, token })` from the port and token you
already know.

## What the client covers

| Area | Methods |
| --- | --- |
| Projects and sessions | `listProjects`, `createProject`, `listSessions`, `getSession` |
| Runs | `startRun`, `getRun`, `waitForRun` |
| Artifacts and packages | `listArtifacts`, `downloadArtifact`, `downloadSessionPackage`, `importSessionPackage`, `replayVersion` |
| Machine state | `getReadiness`, `listRuntimes`, `listConnectors`, `getCapabilities` |
| Unattended approvals | `pendingPermissions`, `respondPermission` |
| Live events | `events` (a WebSocket stream of run events and permission requests) |

Approvals are the half a headless caller cannot do without: a run that needs permission has no window to
click in, so `pendingPermissions()` is the only way to see why it stopped, and `respondPermission()` is
how it continues.

## Type declarations

`index.d.ts` is checked against the runtime on every run: `declaration-surface.test.ts` compares the
declared method names with `PureScienceClient.prototype` and names the transport internals that are
deliberately not exported. A method cannot ship without a declaration, and a declaration cannot outlive
its method.


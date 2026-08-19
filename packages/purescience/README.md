# @zerolink/purescience

Node.js SDK and command-line client for an PureScience daemon running on the local machine.

## Documentation

- [CLI guide](./CLI.md) - installation, daemon lifecycle, task automation, artifacts, and exit codes

## SDK quick start

```js
import { connectToPureScience } from '@zerolink/purescience'

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

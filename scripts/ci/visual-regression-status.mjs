#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Reads the visual regression lane's exit code and says what the certification record may claim.
//
// The mapping itself lives in ./lane-status.mjs, because the Windows P0 lane needs exactly the same
// three-state reading (`passed` / `failed` / `not-applicable`) and two copies of a judge is how the two
// drift apart. This file keeps its own name so the workflow, the record writer and the workflow contract
// test keep pointing at the visual lane explicitly.
import { visualRegressionStatus } from './lane-status.mjs'

export { visualRegressionStatus }

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${visualRegressionStatus(process.argv[2])}\n`)
}

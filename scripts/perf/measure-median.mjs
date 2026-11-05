#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node ESM script run by hand, not
   bundled or type-checked; the shapes are documented in JSDoc above each helper instead. */
// Runs one perf spec N times and reports the median per-turn cost with the observed spread.
//
// Why this exists: at 160 turns the same build produced 116.7 / 124.3 / 130.4 / 156.4 ms per turn in
// consecutive runs — a ±25% band wider than the effect of any single optimisation. A single reading
// cannot answer "is this faster?", so conclusions in that size class have to come from a median over
// several runs, reported together with the spread.
//
//   node scripts/perf/measure-median.mjs --turns 160 --runs 5
//   node scripts/perf/measure-median.mjs --turns 160 --runs 3 --spec e2e/perf/profile-turns.spec.ts
//
// Build first (`npm run build:e2e`); this script never rebuilds, so every run measures one bundle.

import { execFileSync } from 'node:child_process'
import { loadavg } from 'node:os'

/** @returns {{turns: number, runs: number, spec: string, wait: string}} */
const parseArgs = (argv) => {
  const options = { turns: 160, runs: 5, spec: 'e2e/perf/smoothness.spec.ts', wait: 'selector' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--turns') options.turns = Number(value)
    else if (flag === '--runs') options.runs = Number(value)
    else if (flag === '--spec') options.spec = value
    else if (flag === '--wait') options.wait = value
  }
  return options
}

/** @returns {number} */
const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const PER_TURN = /per turn: task=([\d.]+)ms script=([\d.]+)ms/

// The host is shared with whatever else the user is running (their app, the editor, other agents). On a
// loaded machine the same build drifts by tens of percent, so the load band is part of the reading: two
// numbers taken at different loads are not comparable, however many runs each of them averaged.
const options = parseArgs(process.argv.slice(2))
const findings = []
const loadAtStart = loadavg()
console.log(`load before: 1m=${loadAtStart[0].toFixed(2)} 5m=${loadAtStart[1].toFixed(2)}`)

for (let index = 0; index < options.runs; index += 1) {
  let output = ''
  try {
    output = execFileSync('npx', ['playwright', 'test', options.spec, '--reporter=line'], {
      env: { ...process.env, PERF_TURNS: String(options.turns), PERF_WAIT: options.wait },
      encoding: 'utf8'
    })
  } catch (error) {
    // A failed run still prints its perf lines before exiting; keep them so the batch is not wasted.
    output = `${error.stdout ?? ''}`
  }
  const match = PER_TURN.exec(output)
  if (!match) {
    console.error(`run ${index + 1}: no per-turn reading — skipped`)
    continue
  }
  const task = Number(match[1])
  const script = Number(match[2])
  findings.push({ task, script })
  console.log(`run ${index + 1}: task=${task}ms script=${script}ms`)
}

if (findings.length === 0) {
  console.error('no runs produced a reading')
  process.exit(1)
}

const tasks = findings.map((finding) => finding.task)
const scripts = findings.map((finding) => finding.script)
/** @returns {string} */
const fmt = (value) => `${value.toFixed(1)}ms`
const spread = ((Math.max(...tasks) - Math.min(...tasks)) / median(tasks)) * 100

console.log('')
console.log(`turns=${options.turns} runs=${findings.length} spec=${options.spec}`)
console.log(
  `task   median=${fmt(median(tasks))} min=${fmt(Math.min(...tasks))} max=${fmt(Math.max(...tasks))}`
)
console.log(
  `script median=${fmt(median(scripts))} min=${fmt(Math.min(...scripts))} max=${fmt(Math.max(...scripts))}`
)
const loadAtEnd = loadavg()
console.log(`load after:  1m=${loadAtEnd[0].toFixed(2)} 5m=${loadAtEnd[1].toFixed(2)}`)
if (Math.max(loadAtStart[0], loadAtStart[1]) > 4) {
  console.log('WARNING: host load above 4 — treat these numbers as relative to this run only')
}
console.log(`spread=${spread.toFixed(1)}% of median — anything smaller is not a measurement`)

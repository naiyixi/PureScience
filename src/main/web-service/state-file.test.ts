import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  readWebServiceState,
  removeWebServiceState,
  removeWebServiceStateIfOwned,
  statePathFor,
  writeWebServiceState
} from './state-file'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('web service state file', () => {
  it('writes, reads, and removes a live state atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-state-'))
    roots.push(root)
    const state = await writeWebServiceState(root, {
      pid: process.pid,
      port: 44100,
      startedAt: '2026-07-19T00:00:00.000Z',
      appVersion: '0.4.0',
      attached: false
    })

    expect(state.configRoot).toBe(root)
    expect(state.attached).toBe(false)
    expect(await readWebServiceState(root)).toEqual(state)
    expect(JSON.parse(await readFile(statePathFor(root), 'utf8'))).toEqual(state)

    await removeWebServiceState(root)
    expect(await readWebServiceState(root)).toBeUndefined()
  })

  it('preserves an attached flag and defaults it to false for pre-existing state files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-state-'))
    roots.push(root)

    const attached = await writeWebServiceState(root, {
      pid: process.pid,
      port: 44100,
      startedAt: '2026-07-19T00:00:00.000Z',
      appVersion: '0.4.0',
      attached: true
    })
    expect((await readWebServiceState(root))?.attached).toBe(true)
    expect(attached.attached).toBe(true)

    // A state file written before `attached` existed reads back as a dedicated (non-attached) daemon.
    await writeFile(
      statePathFor(root),
      JSON.stringify({
        pid: process.pid,
        port: 44100,
        startedAt: '2026-07-19T00:00:00.000Z',
        appVersion: '0.4.0',
        configRoot: root
      })
    )
    expect((await readWebServiceState(root))?.attached).toBe(false)
  })

  it('removes stale and invalid state files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-state-'))
    roots.push(root)
    await writeFile(
      statePathFor(root),
      JSON.stringify({
        pid: 2_147_483_647,
        port: 44100,
        startedAt: '2026-07-19T00:00:00.000Z',
        appVersion: '0.4.0',
        configRoot: root
      })
    )
    expect(await readWebServiceState(root)).toBeUndefined()

    await writeFile(statePathFor(root), '{broken')
    expect(await readWebServiceState(root)).toBeUndefined()
  })

  it('only removes the record while it still names the calling process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-state-'))
    roots.push(root)
    await writeWebServiceState(root, {
      pid: process.pid,
      port: 44100,
      startedAt: '2026-07-19T00:00:00.000Z',
      appVersion: '0.4.0',
      attached: false
    })

    // A different process shutting down (an older generation, or a second launch) must leave it alone:
    // deleting someone else's record is what makes a listening service look absent to the CLI.
    await removeWebServiceStateIfOwned(root, process.pid + 1)
    expect(JSON.parse(await readFile(statePathFor(root), 'utf8')).pid).toBe(process.pid)

    await removeWebServiceStateIfOwned(root, process.pid)
    await expect(readFile(statePathFor(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves an unreadable record for the read path to prune instead of deleting it by inference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purescience-state-'))
    roots.push(root)
    await writeFile(statePathFor(root), '{broken')

    await removeWebServiceStateIfOwned(root, process.pid)
    expect(await readFile(statePathFor(root), 'utf8')).toBe('{broken')
  })
})

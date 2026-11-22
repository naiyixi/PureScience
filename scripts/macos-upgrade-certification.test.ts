import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  archMismatch,
  bundleVersion,
  findBundle,
  normaliseArch,
  normaliseVersionInput,
  readUserDataMarker,
  runProcess,
  seedUserDataMarker,
  userDataDir,
  waitForVersionOnDisk
} from './macos-upgrade-certification.mjs'

// The drill itself needs a real released .app and the network, so what is pinned here is the part that
// decides whether it passed: where the bundle is, which version the bundle claims, and what happens when
// the hand-over never puts the next version there. A drill whose failure path is untested reports
// "failed" for the same reason it reports "passed" — because a string was there.
//
// What the version tests pin is `plutil`'s answer — "the version a user sees in Get Info", the app's own
// testimony rather than a field we rewrote — so they can only run where `plutil` exists. Measured on the
// Windows lane (run 44984143602, job 137090909581): all four burned the full 120 s and the shard failed,
// because a spawn that cannot find its binary reports `error` and never `close` (the runner now settles on
// that event, and the test below pins it). `findBundle` stays ungated: it is plain file-system work.
const itOnMac = it.skipIf(process.platform !== 'darwin')
const makeBundle = async (root: string, version: string, nested = false): Promise<string> => {
  const directory = nested ? join(root, 'nested') : root
  const bundle = join(directory, 'PureScience.app')
  const contents = join(bundle, 'Contents')
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await writeFile(
    join(contents, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>CFBundleShortVersionString</key>',
      `<string>${version}</string>`,
      '<key>CFBundleExecutable</key>',
      '<string>purescience</string>',
      '</dict></plist>'
    ].join('\n')
  )
  return bundle
}

describe('macOS upgrade drill', () => {
  it('finds a bundle one level down, because a zip does not promise to unpack flat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-mac-upgrade-find-'))
    try {
      await makeBundle(root, '2.33.0', true)
      expect(await findBundle(root)).toBe(join(root, 'nested', 'PureScience.app'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itOnMac('reads the version a user sees in Get Info, not a file we wrote ourselves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-mac-upgrade-version-'))
    try {
      const bundle = await makeBundle(root, '2.33.0')
      expect(await bundleVersion(bundle)).toBe('2.33.0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itOnMac('passes only when the bundle on disk carries the next version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-mac-upgrade-handover-'))
    try {
      const bundle = await makeBundle(root, '2.33.1')
      expect(await waitForVersionOnDisk(bundle, '2.33.1')).toBe('2.33.1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itOnMac('fails, naming what it found, when the hand-over never happened', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-mac-upgrade-stale-'))
    try {
      const bundle = await makeBundle(root, '2.33.0')
      // 0 ms budget: the point is the sentence, not the wait.
      await expect(waitForVersionOnDisk(bundle, '2.33.1', 0)).rejects.toThrow(
        /still reads 2\.33\.0 .*did not put 2\.33\.1 there/s
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  itOnMac('names an unreadable bundle as unreadable rather than as the wrong version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ps-mac-upgrade-missing-'))
    try {
      await expect(waitForVersionOnDisk(join(root, 'nowhere.app'), '2.33.1', 0)).rejects.toThrow(
        /still reads \(unreadable\)/
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // The drill's process runner has to settle on a binary it cannot start. It used to wait for `close`,
  // which a failed spawn never sends — that is how a missing `plutil` became four 120 s timeouts on a lane
  // that never runs the drill at all. This one runs everywhere: no platform has the name below.
  it('names a binary it cannot start instead of waiting out its budget', async () => {
    await expect(runProcess('ps-no-such-binary-2f4d', [], { timeoutMs: 30_000 })).rejects.toThrow(
      /^ps-no-such-binary-2f4d could not be started: /
    )
  })
})

describe('the next_version argument is read the way people actually type it', () => {
  // Run 45001026264 failed with "The feed did not offer v2.33.2" while the payload beside it said
  // `latest: 2.33.2`: the argument carried a `v`, the feed does not. The failure named the feed, so the
  // next hour would have gone into the feed instead of the argument.
  it('accepts a leading v and surrounding whitespace', () => {
    expect(normaliseVersionInput('v2.33.2')).toBe('2.33.2')
    expect(normaliseVersionInput('  2.33.2 ')).toBe('2.33.2')
    expect(normaliseVersionInput('V2.33.2')).toBe('2.33.2')
  })

  it('leaves a bare version and a missing value alone', () => {
    expect(normaliseVersionInput('2.33.2')).toBe('2.33.2')
    expect(normaliseVersionInput(undefined)).toBeUndefined()
  })
})

describe('an architecture mismatch is refused instead of reported as an upgrade', () => {
  // Rosetta lets an x86_64 bundle start on an arm64 runner, so "it launched and updated" would be true and
  // still not be the thing a user on that architecture does. `macos-15-intel` exists for the other half.
  it('accepts the pair each runner actually provides', () => {
    expect(archMismatch('arm64', 'arm64')).toBeNull()
    expect(archMismatch('x86_64', 'x86_64')).toBeNull()
    expect(archMismatch('x86_64 arm64', 'arm64')).toBeNull()
  })

  it('names both sides when they disagree', () => {
    const said = archMismatch('x86_64', 'arm64')
    expect(said).toContain('x64')
    expect(said).toContain('this host is arm64')
  })

  it('does not read an unreadable answer as agreement', () => {
    expect(archMismatch('', 'arm64')).toContain('no architecture')
  })

  it('normalises the names the two tools use', () => {
    expect(normaliseArch('x86_64')).toBe('x64')
    expect(normaliseArch('aarch64')).toBe('arm64')
  })
})

// The user-data half of the drill: a swap that puts the right version on disk but hands the new build an
// empty store has destroyed the thing the user actually cares about. What makes that assertion meaningful
// is that it can fail — a missing file, a re-created file, and a file with rewritten contents all have to
// read differently, otherwise the whole check is a string that is always there.
describe('the user-data marker the drill leaves behind', () => {
  const withHome = async (body: (home: string) => Promise<void>): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'drill-home-'))
    try {
      await body(home)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  it('lands in the directory the packaged app calls its own', async () => {
    await withHome(async (home) => {
      expect(userDataDir(home)).toBe(join(home, 'Library', 'Application Support', 'PureScience'))
      const path = await seedUserDataMarker(userDataDir(home), 'token-1')
      expect(path).toBe(join(userDataDir(home), 'drill-marker.json'))
      // Called with the storage root it puts the marker at the root of that directory instead — the drill
      // seeds both, and neither may land outside the directory it was given.
      expect(await seedUserDataMarker(home, 'token-2')).toBe(join(home, 'drill-marker.json'))
    })
  })

  it('reads back the token it wrote, and reports a missing file as missing', async () => {
    await withHome(async (home) => {
      const path = await seedUserDataMarker(userDataDir(home), 'token-1')
      expect(await readUserDataMarker(path)).toBe('token-1')
      await rm(path)
      expect(await readUserDataMarker(path)).toBeUndefined()
    })
  })

  it('does not read a rewritten file as the original token', async () => {
    await withHome(async (home) => {
      const path = await seedUserDataMarker(userDataDir(home), 'token-1')
      await writeFile(path, JSON.stringify({ token: 'token-2' }), 'utf8')
      expect(await readUserDataMarker(path)).toBe('token-2')
      // Not JSON at all still has to come back as *something that is not the token*, or a corrupted file
      // would compare equal by both sides being undefined.
      await writeFile(path, 'garbage', 'utf8')
      expect(await readUserDataMarker(path)).toBe('garbage')
    })
  })
})

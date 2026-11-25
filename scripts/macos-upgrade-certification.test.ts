import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  applyDataSabotage,
  compareVersions,
  feedWaitDecision,
  feedOffers,
  parseUpdateConfig,
  archMismatch,
  bundleVersion,
  CHECK_TIMEOUT_MS,
  DOWNLOAD_STALL_MS,
  DOWNLOAD_TIMEOUT_MS,
  awaitDownloadWithProgress,
  downloadWatchStep,
  findBundle,
  normaliseArch,
  normaliseVersionInput,
  readUserDataMarker,
  runProcess,
  seedUserDataMarker,
  userDataDir,
  waitForVersionOnDisk,
  withTimeout
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

// The reverse control. Without it the data reading could be "kept" because nothing was ever written where
// it looks, or because `readUserDataMarker` cannot see a deletion — both would still print `kept`.
describe('the reverse control for the data markers', () => {
  const withMarkers = async (
    body: (paths: { userData: string; storage: string }) => Promise<void>
  ): Promise<void> => {
    const home = await mkdtemp(join(tmpdir(), 'drill-sabotage-'))
    try {
      const paths = {
        userData: await seedUserDataMarker(join(home, 'user-data'), 'token-1'),
        storage: await seedUserDataMarker(join(home, 'storage'), 'token-1')
      }
      await body(paths)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }

  it('removes only the marker it was asked for, and says which', async () => {
    await withMarkers(async (paths) => {
      const removed = await applyDataSabotage(paths, 'storage')
      expect(removed).toHaveLength(1)
      expect(removed[0]).toContain('storage')
      expect(await readUserDataMarker(paths.storage)).toBeUndefined()
      expect(await readUserDataMarker(paths.userData)).toBe('token-1')
    })
  })

  it('does nothing for `none` or an unknown mode', async () => {
    await withMarkers(async (paths) => {
      expect(await applyDataSabotage(paths, 'none')).toEqual([])
      expect(await applyDataSabotage(paths, '')).toEqual([])
      expect(await readUserDataMarker(paths.userData)).toBe('token-1')
      expect(await readUserDataMarker(paths.storage)).toBe('token-1')
    })
  })

  it('skips a marker that was never seeded instead of throwing', async () => {
    await withMarkers(async (paths) => {
      const removed = await applyDataSabotage(
        { userData: undefined, storage: paths.storage },
        'both'
      )
      expect(removed).toHaveLength(1)
      expect(removed[0]).toContain('storage')
    })
  })
})

// The feed half of the reading. Both assertions have to be able to fail: a build pointed at the wrong feed
// is a build that will never update, and a feed that answers with a different version is a mirror that was
// not re-pointed. `feedOffers` is given a fake `fetch` so the test does not need the network.
describe('the feed the shipped build polls', () => {
  it('reads provider and url out of a flat app-update.yml', () => {
    const yaml = [
      'provider: generic',
      'url: https://purescience.work/download/feed/',
      'channel: latest'
    ].join('\n')
    expect(parseUpdateConfig(yaml)).toEqual({
      provider: 'generic',
      url: 'https://purescience.work/download/feed/',
      channel: 'latest'
    })
  })

  it('comes back undefined for keys that are not there, so a wrong shape cannot pass as right', () => {
    expect(parseUpdateConfig('provider: github\nowner: naiyixi').url).toBeUndefined()
  })

  it('asks the feed for this platform file and reports the version it carries', async () => {
    const calls: string[] = []
    const fetchImpl = async (target: string): Promise<Response> => {
      calls.push(target)
      return new Response('version: 2.33.3\nfiles:\n  - url: a.zip\n', { status: 200 })
    }
    const feed = await feedOffers('https://purescience.work/download/feed/', fetchImpl as never)
    expect(calls[0]).toBe(
      `https://purescience.work/download/feed/${process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'}`
    )
    expect(feed.version).toBe('2.33.3')
  })

  it('throws by name when the mirror answers with an error or with something that is not a feed', async () => {
    const notFound = async (): Promise<Response> =>
      new Response('<html>404</html>', { status: 404 })
    await expect(feedOffers('https://x/download/feed', notFound as never)).rejects.toThrow(
      /answered 404/
    )

    const html = async (): Promise<Response> => new Response('<!doctype html>', { status: 200 })
    await expect(feedOffers('https://x/download/feed', html as never)).rejects.toThrow(
      /no version line/
    )
  })
})

// The wait that keeps a tag-push drill alive until the release has published. Getting its direction right is
// the whole point: `wait` on a feed that is behind, `ahead` on a feed that already offers something newer (a
// re-drill of an old tag), and `proceed` as soon as the feed offers anything else at all.
describe('waiting for the release to publish', () => {
  it('reads versions numerically, not as strings', () => {
    expect(compareVersions('2.33.10', '2.33.9')).toBe(1)
    expect(compareVersions('v2.33.2', '2.33.10')).toBe(-1)
    expect(compareVersions('2.34.0', '2.33.99')).toBe(1)
    expect(compareVersions('2.33.2', '2.33.2')).toBe(0)
  })

  it('waits when the feed is behind the target, and refuses when it is already ahead', () => {
    expect(feedWaitDecision({ state: 'up-to-date', latest: '2.33.2' }, '2.33.3')).toBe('wait')
    expect(feedWaitDecision({ state: 'up-to-date', latest: '2.34.0' }, '2.33.3')).toBe('ahead')
  })

  it('proceeds on anything that is not "up-to-date" — including a named error', () => {
    expect(feedWaitDecision({ state: 'available', latest: '2.33.3' }, '2.33.3')).toBe('proceed')
    expect(feedWaitDecision({ state: 'error', error: 'timeout' }, '2.33.3')).toBe('proceed')
  })
})

// The timeout that gave the wrong reason. On the published v2.33.5 lane both architectures died with
// "Timed out after 120000 ms: update.download" while the download had actually been given 15 minutes and
// had used 901 s of them (run 45351488221, jobs 138388881425 / 138388881615). Whoever read that line went
// after a two-minute slowdown; nothing had run out at two minutes. These tests pin the contract the message
// has to keep: the budget it names is the budget it used, and a caller can make it say what was seen.
describe('a timeout names the budget it used', () => {
  const never = (): Promise<never> => new Promise<never>(() => {})

  it('reports the budget it was given, not a constant from somewhere else', async () => {
    await expect(withTimeout(never(), 'update.download', { timeoutMs: 40 })).rejects.toThrow(
      'Timed out after 40 ms (0 s): update.download'
    )
  })

  it('keeps the download budget far larger than a check, so the two cannot be confused', () => {
    // The mislabeled red read 120000 while 900000 was in force — a 7.5× gap is what made the line
    // believable and wrong. The gap stays, and it is asserted here so a future "tighten the timeout"
    // edit cannot quietly make a 296 MB transfer fail at two minutes.
    expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(CHECK_TIMEOUT_MS * 5)
  })

  it('separates a stall from a ceiling, and puts the stall well outside the sampling interval', () => {
    // A stall shorter than a couple of samples would fire on ordinary jitter; a ceiling at or below the
    // observed 900 s is what cut a working 97 % transfer off. Both relations are asserted so neither can
    // be "tightened" back into the shape that failed.
    expect(DOWNLOAD_STALL_MS).toBeGreaterThan(CHECK_TIMEOUT_MS)
    expect(DOWNLOAD_STALL_MS).toBeLessThan(DOWNLOAD_TIMEOUT_MS)
    expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(900_000)
  })

  it('appends what the app last reported, so a red names bytes instead of only waiting', async () => {
    const error = await withTimeout(never(), 'update.download', {
      timeoutMs: 40,
      describe: async () =>
        'after 901s the app reported {"state":"downloading","progress":14,"downloadedBytes":41398272}'
    }).catch((caught: unknown) => caught as Error)
    expect(error.message).toContain('Timed out after 40 ms (0 s): update.download')
    expect(error.message).toContain('"progress":14')
    expect(error.message).toContain('"downloadedBytes":41398272')
  })

  it('does not lose the timeout when the reading itself fails', async () => {
    const error = await withTimeout(never(), 'update.download', {
      timeoutMs: 40,
      describe: async () => {
        throw new Error('Target page, context or browser has been closed')
      }
    }).catch((caught: unknown) => caught as Error)
    expect(error.message).toContain('Timed out after 40 ms (0 s): update.download')
    expect(error.message).toContain('the last reading was unreadable')
  })

  it('passes a value through untouched and does not fire the timer afterwards', async () => {
    const value = await withTimeout(Promise.resolve({ state: 'ready' }), 'update.download', {
      timeoutMs: 40
    })
    expect(value).toEqual({ state: 'ready' })
    // A settled promise that later hits its timer would reject an already-resolved promise, which surfaces
    // as an unhandled rejection in the lane rather than as a failure with a name.
    await new Promise((resolveWait) => setTimeout(resolveWait, 80))
  })
})

// The download is the one wait that used to be judged by a clock, and the clock was wrong in the direction
// that matters: on the x64 runner a 312 MB transfer was 303,103,964 of 312,507,252 bytes (97 %) and still
// moving when a flat 900 s budget cut it off (run 45521816671, job 138895353020). A flat budget cannot tell
// "slow" from "dead", so the replacement decides on bytes. These pin the three outcomes apart, because
// "it waited a long time" is not one of them.
describe('the download wait follows bytes, not the clock', () => {
  const T0 = 1_000_000
  const fresh = (): {
    startedAt: number
    lastAdvanceAt: number
    bestBytes: number
    totalBytes: number
    lastSample: unknown
  } => ({ startedAt: T0, lastAdvanceAt: T0, bestBytes: -1, totalBytes: 0, lastSample: null })
  const sample = (
    downloadedBytes: number,
    totalBytes = 312_507_252
  ): { state: string; downloadedBytes: number; totalBytes: number } => ({
    state: 'downloading',
    downloadedBytes,
    totalBytes
  })

  it('keeps waiting while bytes arrive, even past the stall budget in total', () => {
    let watch = fresh()
    let now = T0
    for (const bytes of [1_000_000, 50_000_000, 303_103_964]) {
      now += 170_000
      const step = downloadWatchStep(watch, sample(bytes), now)
      expect(step.verdict).toBe('wait')
      watch = step.watch
    }
    // 510 s of waiting with no stall budget on a wall clock: this is exactly the transfer that failed.
    expect(now - T0).toBeGreaterThan(DOWNLOAD_STALL_MS)
    expect(watch.bestBytes).toBe(303_103_964)
  })

  it('fails as stalled, naming bytes and rate, when no byte arrives for the stall budget', () => {
    const first = downloadWatchStep(fresh(), sample(10_000_000), T0 + 5_000)
    const stalled = downloadWatchStep(
      first.watch,
      sample(10_000_000),
      T0 + 5_000 + DOWNLOAD_STALL_MS
    )
    expect(stalled.verdict).toBe('stalled')
    expect(stalled.message).toContain(`no progress for ${Math.round(DOWNLOAD_STALL_MS / 1000)} s`)
    expect(stalled.message).toContain('10000000 of 312507252 bytes')
    expect(stalled.message).toMatch(/KB\/s/)
  })

  it('does not read a restarted transfer as progress', () => {
    // A resumed or re-issued download that reports fewer bytes than before has not moved forward; if that
    // counted, a transfer that kept restarting could extend itself forever.
    const first = downloadWatchStep(fresh(), sample(200_000_000), T0 + 5_000)
    const restarted = downloadWatchStep(
      first.watch,
      sample(1_000_000),
      T0 + 5_000 + DOWNLOAD_STALL_MS
    )
    expect(restarted.verdict).toBe('stalled')
    expect(restarted.watch.bestBytes).toBe(200_000_000)
    expect(restarted.message).toContain('200000000 of 312507252 bytes')
  })

  it('names a ceiling as the mirror rate, not a hang, when it moved all the way', () => {
    const watch = {
      ...fresh(),
      bestBytes: 300_000_000,
      lastAdvanceAt: T0 + DOWNLOAD_TIMEOUT_MS - 5_000
    }
    const capped = downloadWatchStep(watch, sample(300_000_000), T0 + DOWNLOAD_TIMEOUT_MS)
    expect(capped.verdict).toBe('ceiling')
    expect(capped.message).toContain('mirror')
    expect(capped.message).toContain('not a hang')
  })

  it('lets an unreadable status neither advance the wait nor end it early', () => {
    const watch = { ...fresh(), bestBytes: 5_000_000, lastAdvanceAt: T0 }
    expect(downloadWatchStep(watch, null, T0 + 60_000).verdict).toBe('wait')
    expect(downloadWatchStep(watch, null, T0 + DOWNLOAD_STALL_MS + 1).verdict).toBe('stalled')
  })
})

describe('awaitDownloadWithProgress', () => {
  it('returns the download value and does not wait for a sample', async () => {
    const value = await awaitDownloadWithProgress({
      download: Promise.resolve({ state: 'ready' }),
      readStatus: async () => ({ downloadedBytes: 1 }),
      pollMs: 50,
      log: () => undefined
    })
    expect(value).toEqual({ state: 'ready' })
  })

  it('survives a transfer that outlasts the stall budget as long as bytes keep arriving', async () => {
    // The regression: 120 ms of transfer against a 60 ms stall budget. A wall-clock budget rejects here; a
    // progress watch must not, because every sample is larger than the last.
    let bytes = 0
    const download = new Promise<{ state: string }>((resolveDone) =>
      setTimeout(() => resolveDone({ state: 'ready' }), 120)
    )
    const value = await awaitDownloadWithProgress({
      download,
      readStatus: async () => ({ downloadedBytes: (bytes += 10_000), totalBytes: 200_000 }),
      pollMs: 5,
      stallMs: 60,
      log: () => undefined
    })
    expect(value).toEqual({ state: 'ready' })
    expect(bytes).toBeGreaterThan(10_000)
  })

  it('rejects with the stall reading when the status stops moving', async () => {
    const error = await awaitDownloadWithProgress({
      download: new Promise(() => undefined),
      readStatus: async () => ({ downloadedBytes: 7_000, totalBytes: 312_507_252 }),
      pollMs: 5,
      stallMs: 30,
      log: () => undefined
    }).catch((caught: unknown) => caught as Error)
    expect(error.message).toContain('update.download made no progress')
    expect(error.message).toContain('7000 of 312507252 bytes')
  })
})

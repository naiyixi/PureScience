import { afterEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the electron mock and the test bodies agree on the reported OS language without either
// one capturing the other at module-load time.
const { localeState } = vi.hoisted(() => ({ localeState: { code: 'en' } }))

vi.mock('electron', () => ({
  app: { getLocale: (): string => localeState.code },
  dialog: { showMessageBoxSync: vi.fn() }
}))

const {
  acquireDataRootWriter,
  beginMigration,
  clearMigrationPending,
  endMigration,
  endMigrationCopy,
  installMigrationQuitGuard,
  isMigrationInProgress,
  isMigrationPending,
  migrationQuitDialogOptions,
  waitForDataRootWriters,
  withDataRootWrite
} = await import('./migration-state')

const { MIGRATION_QUIT_STRINGS } = await import('../native-dialog-strings')
const { NATIVE_LOCALE_CODES } = await import('../native-locale')

// A minimal app double: records the before-quit listener and whether quit() was called.
type GuardApp = Parameters<typeof installMigrationQuitGuard>[0]
const makeApp = (): GuardApp & { fireBeforeQuit: () => { prevented: boolean } } => {
  let listener: ((event: { preventDefault: () => void }) => void) | undefined
  const quit = vi.fn()
  return {
    on: ((event: string, fn: (event: { preventDefault: () => void }) => void) => {
      if (event === 'before-quit') listener = fn
    }) as GuardApp['on'],
    quit,
    fireBeforeQuit: () => {
      let prevented = false
      listener?.({ preventDefault: () => (prevented = true) })
      return { prevented }
    }
  }
}

afterEach(() => {
  endMigration()
  vi.clearAllMocks()
})

describe('migration-state', () => {
  it('tracks in-progress state via begin/end', () => {
    expect(isMigrationInProgress()).toBe(false)
    beginMigration()
    expect(isMigrationInProgress()).toBe(true)
    endMigration()
    expect(isMigrationInProgress()).toBe(false)
  })

  it('beginMigration sets both the copying (quit) and pending (write-gate) flags', () => {
    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)

    beginMigration()

    expect(isMigrationInProgress()).toBe(true)
    expect(isMigrationPending()).toBe(true)
  })

  it('endMigrationCopy relaxes the quit guard but keeps the write-gate pending', () => {
    beginMigration()
    endMigrationCopy()

    // The copy finished, so quit is no longer blocked — but a successful-but-uncommitted copy still
    // blocks writes until commit or discard resolves it.
    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(true)
  })

  it('clearMigrationPending lifts both flags (copy failed/cancelled/discarded, or switch failed)', () => {
    beginMigration()
    endMigrationCopy()
    clearMigrationPending()

    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)
  })

  it('endMigration clears both flags (quit-anyway path)', () => {
    beginMigration()
    endMigration()

    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)
  })

  it('drains writes that started before migration and rejects new writes after the gate rises', async () => {
    let releaseWrite: (() => void) | undefined
    let writeStarted = false
    const activeWrite = withDataRootWrite(
      () =>
        new Promise<void>((resolve) => {
          writeStarted = true
          releaseWrite = resolve
        })
    )
    expect(writeStarted).toBe(true)

    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(withDataRootWrite(async () => {})).rejects.toThrow(/moving your data/i)

    releaseWrite?.()
    await activeWrite
    await drainPromise
    expect(drained).toBe(true)
  })

  it('allows a drained writer to enter nested protected repositories after the gate rises', async () => {
    let continueOuter: (() => void) | undefined
    const outerStarted = new Promise<void>((resolve) => {
      continueOuter = resolve
    })
    let entered = false
    const operation = withDataRootWrite(async () => {
      await outerStarted
      await withDataRootWrite(async () => {
        entered = true
      })
    })
    beginMigration()

    continueOuter?.()
    await operation

    expect(entered).toBe(true)
  })

  it('keeps a logical writer active across calls until its idempotent release', async () => {
    const release = acquireDataRootWriter()
    beginMigration()

    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    release()
    release()
    await drainPromise
    expect(drained).toBe(true)
  })

  it('quit guard does not interfere when no migration is running', () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(false)
    installMigrationQuitGuard(app, confirmQuit)

    const { prevented } = app.fireBeforeQuit()

    expect(prevented).toBe(false)
    expect(confirmQuit).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('quit guard blocks the quit and stays when the user declines mid-migration', () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(false)
    installMigrationQuitGuard(app, confirmQuit)
    beginMigration()

    const { prevented } = app.fireBeforeQuit()

    expect(prevented).toBe(true)
    expect(confirmQuit).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()
    expect(isMigrationInProgress()).toBe(true)
  })

  it('quit guard clears the flag and re-issues quit when the user confirms', () => {
    const app = makeApp()
    const confirmQuit = vi.fn().mockReturnValue(true)
    installMigrationQuitGuard(app, confirmQuit)
    beginMigration()

    const { prevented } = app.fireBeforeQuit()

    // Prevented on this pass, but the flag is cleared and quit re-issued so the next pass falls through.
    expect(prevented).toBe(true)
    expect(isMigrationInProgress()).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})

// The mid-migration quit confirm is drawn outside the renderer, so nothing else in the product can
// prove it reached the reader's language: this drives the real options builder through every locale
// the app ships and asserts the wording the OS-language cascade resolved to is the one on the buttons.
describe('migrationQuitDialogOptions', () => {
  afterEach(() => {
    localeState.code = 'en'
  })

  it('puts the safe choice first and makes it both the default and the cancel action', () => {
    const options = migrationQuitDialogOptions()
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.type).toBe('warning')
  })

  it('carries no English sentence once the OS language is one of the other eight', () => {
    for (const code of NATIVE_LOCALE_CODES) {
      localeState.code = code
      const options = migrationQuitDialogOptions()
      const row = MIGRATION_QUIT_STRINGS[code]
      expect(options.buttons).toEqual([row.keepWaiting, row.quitAnyway])
      expect(options.title).toBe(row.title)
      expect(options.message).toBe(row.message)
      expect(options.detail).toBe(row.detail)
      if (code === 'en') continue
      expect(options.message).not.toBe(MIGRATION_QUIT_STRINGS.en.message)
      expect(options.buttons).not.toEqual([
        MIGRATION_QUIT_STRINGS.en.keepWaiting,
        MIGRATION_QUIT_STRINGS.en.quitAnyway
      ])
    }
  })

  it('falls back to English for a language the app does not ship', () => {
    localeState.code = 'pt-BR'
    const options = migrationQuitDialogOptions()
    expect(options.buttons).toEqual([
      MIGRATION_QUIT_STRINGS.en.keepWaiting,
      MIGRATION_QUIT_STRINGS.en.quitAnyway
    ])
  })
})

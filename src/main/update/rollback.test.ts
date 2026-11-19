// 升级回滚的判据：备份真的能盖回去、标记读不懂就当没有、同一个新版本连续起不来才回滚。
//
// 这些用例存在的理由很具体：回滚是不可逆的破坏性操作（先删安装目录再复制）。写错了会把能用的版本也删掉，
// 所以每条路径都要有测试钉住，包括「备份缺失时宁可报错也不动手」。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  backupInstallDir,
  clearPendingUpdate,
  decideRollback,
  isNonEmptyDir,
  markUpdateHealthy,
  readPendingUpdate,
  restoreInstallDir,
  rollbackPaths,
  writePendingUpdate,
  type PendingUpdate
} from './rollback'

const temp = (): string => mkdtempSync(join(tmpdir(), 'ps-rollback-'))

const seedInstall = (dir: string): void => {
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'purescience.exe'), 'v1-binary')
  writeFileSync(join(dir, 'resources', 'app.asar'), 'v1-asar')
}

describe('update rollback', () => {
  it('restores a broken install from the backup, and removes files the new version added', () => {
    const root = temp()
    const installDir = join(root, 'app')
    const backupDir = join(root, 'backup')
    seedInstall(installDir)
    backupInstallDir(installDir, backupDir)

    // 模拟一个装坏的新版本：关键文件没了，还多了一个旧版没有的文件。
    writeFileSync(join(installDir, 'resources', 'app.asar.broken'), 'junk')
    restoreInstallDir(installDir, backupDir)

    expect(readFileSync(join(installDir, 'resources', 'app.asar'), 'utf8')).toBe('v1-asar')
    expect(readFileSync(join(installDir, 'purescience.exe'), 'utf8')).toBe('v1-binary')
    // 「先删再复制」的意义就在这里：覆盖复制会把这个残骸留下来。
    expect(existsSync(join(installDir, 'resources', 'app.asar.broken'))).toBe(false)
  })

  it('refuses to touch the install dir when the backup is missing', () => {
    const root = temp()
    const installDir = join(root, 'app')
    seedInstall(installDir)
    expect(() => restoreInstallDir(installDir, join(root, 'no-such-backup'))).toThrow(
      /backup missing/i
    )
    // 报错之后安装目录必须原封不动——宁可回滚失败，也不能把还能跑的那一份删掉。
    expect(existsSync(join(installDir, 'purescience.exe'))).toBe(true)
  })

  it('reads back what it wrote, and treats an unreadable marker as no marker', () => {
    const root = temp()
    const { markerFile } = rollbackPaths(root)
    const pending: PendingUpdate = {
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir: join(root, 'app'),
      backupDir: join(root, 'backup'),
      healthFile: join(root, 'health'),
      startedAt: 1,
      attempts: 0
    }
    writePendingUpdate(markerFile, pending)
    expect(readPendingUpdate(markerFile)).toEqual(pending)

    writeFileSync(markerFile, '{ not json')
    expect(readPendingUpdate(markerFile)).toBeUndefined()
    expect(readPendingUpdate(join(root, 'absent.json'))).toBeUndefined()
  })

  it('decides by running version and attempt count', () => {
    const base: PendingUpdate = {
      fromVersion: '2.30.2',
      toVersion: '2.31.0',
      installDir: '/app',
      backupDir: '/backup',
      healthFile: '/health',
      startedAt: 0,
      attempts: 0
    }
    expect(decideRollback({ pending: undefined, runningVersion: '2.31.0' })).toBe('none')
    // 标记指向别的版本：上一次更新留下的垃圾，不动它。
    expect(decideRollback({ pending: base, runningVersion: '2.30.2' })).toBe('none')
    expect(decideRollback({ pending: { ...base, attempts: 0 }, runningVersion: '2.31.0' })).toBe(
      'count-attempt'
    )
    expect(decideRollback({ pending: { ...base, attempts: 2 }, runningVersion: '2.31.0' })).toBe(
      'count-attempt'
    )
    expect(decideRollback({ pending: { ...base, attempts: 3 }, runningVersion: '2.31.0' })).toBe(
      'roll-back'
    )
  })

  it('marks health, clears both marker and signal, and reports an empty backup as empty', () => {
    const root = temp()
    const { markerFile, healthFile } = rollbackPaths(root)
    markUpdateHealthy(healthFile, '2.31.0')
    expect(JSON.parse(readFileSync(healthFile, 'utf8')).version).toBe('2.31.0')
    clearPendingUpdate(markerFile, healthFile)
    expect(existsSync(healthFile)).toBe(false)

    const emptyDir = join(root, 'empty')
    mkdirSync(emptyDir)
    expect(isNonEmptyDir(emptyDir)).toBe(false)
    expect(isNonEmptyDir(join(root, 'absent'))).toBe(false)
  })
})

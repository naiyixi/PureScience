import { existsSync, readFileSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { createSshAskPass } from './ssh-runner'

const created: string[] = []

afterEach(() => {
  for (const path of created) rmSync(path, { force: true })
  created.length = 0
})

describe('createSshAskPass', () => {
  it('writes an executable askpass script that echoes the password for password prompts', () => {
    const { scriptPath, cleanup } = createSshAskPass('hunter2')
    created.push(scriptPath)
    expect(existsSync(scriptPath)).toBe(true)
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain("[Pp]assword*")
    expect(script).toContain("echo 'hunter2'")
    cleanup()
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('shell-quotes passwords containing single quotes', () => {
    const { scriptPath, cleanup } = createSshAskPass("pa'ss'word")
    created.push(scriptPath)
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain(`'pa'\\''ss'\\''word'`)
    cleanup()
  })

  it('never answers non-password prompts', () => {
    const { scriptPath, cleanup } = createSshAskPass('secret')
    created.push(scriptPath)
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('*) exit 1 ;;')
    cleanup()
  })
})

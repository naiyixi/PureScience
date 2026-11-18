import { describe, expect, it, vi } from 'vitest'
import {
  isPromptAlreadyRunningError,
  PROMPT_ALREADY_RUNNING_MESSAGE,
  sendPromptWithStaleTurnRecovery
} from './stale-turn-recovery'

const busy = () => new Error(PROMPT_ALREADY_RUNNING_MESSAGE)

describe('sendPromptWithStaleTurnRecovery', () => {
  it('clears the leftover interaction and sends again when the session is not running', async () => {
    const send = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce('sent')
    const cancel = vi.fn().mockResolvedValue(undefined)

    await expect(
      sendPromptWithStaleTurnRecovery({ send, cancel, isSessionIdle: () => true })
    ).resolves.toBe('sent')

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
  })

  // A user hitting send twice must not have their live turn cancelled and restarted.
  it('keeps the failure when the session really is running', async () => {
    const send = vi.fn().mockRejectedValue(busy())
    const cancel = vi.fn()

    await expect(
      sendPromptWithStaleTurnRecovery({ send, cancel, isSessionIdle: () => false })
    ).rejects.toThrow(PROMPT_ALREADY_RUNNING_MESSAGE)

    expect(cancel).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not touch other errors', async () => {
    const send = vi.fn().mockRejectedValue(new Error('provider rejected the request'))
    const cancel = vi.fn()

    await expect(
      sendPromptWithStaleTurnRecovery({ send, cancel, isSessionIdle: () => true })
    ).rejects.toThrow('provider rejected the request')

    expect(cancel).not.toHaveBeenCalled()
  })

  it('surfaces the retry failure rather than the recovered one', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(new Error('provider down'))
    const cancel = vi.fn().mockResolvedValue(undefined)

    await expect(
      sendPromptWithStaleTurnRecovery({ send, cancel, isSessionIdle: () => true })
    ).rejects.toThrow('provider down')
  })
})

describe('isPromptAlreadyRunningError', () => {
  it('recognises the wrapped IPC message and ignores everything else', () => {
    expect(
      isPromptAlreadyRunningError(
        new Error(`Error invoking remote method: ${PROMPT_ALREADY_RUNNING_MESSAGE}`)
      )
    ).toBe(true)
    expect(isPromptAlreadyRunningError(new Error('something else'))).toBe(false)
  })
})

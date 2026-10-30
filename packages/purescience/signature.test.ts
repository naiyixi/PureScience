import { describe, expect, it, vi } from 'vitest'

import {
  checkSignature,
  MAC_FIRST_LAUNCH,
  WINDOWS_FIRST_LAUNCH,
  macBundleRoot,
  parseCodesign
} from './signature.mjs'

// G1 的非花钱半边：这一版没有证书，「装得上但系统不认发布者」必须能被一眼看出来，并且带一句下一步。
// 这些用例钉住的是**读法**：同样的 `codesign` / `spctl` 文本要归到同一个状态，被拒和被篡改不能混为
// 一谈，Linux 也不能被写成「未签名」。
describe('signature reading', () => {
  it('reads an ad-hoc signature as ad-hoc, not as unsigned', () => {
    const text = 'Executable=/Applications/X.app/Contents/MacOS/X\nSignature=adhoc\nIdentifier=x'
    expect(parseCodesign(text)).toEqual({ kind: 'adhoc' })
  })

  it('reads a certificate-backed signature and keeps the authority it names', () => {
    const text =
      'Authority=Developer ID Application: Example GmbH (ABCD123456)\nAuthority=Developer ID Certification Authority'
    expect(parseCodesign(text)).toEqual({
      kind: 'signed',
      authority: 'Developer ID Application: Example GmbH (ABCD123456)'
    })
  })

  it('treats neither-signature-nor-authority as unsigned', () => {
    expect(parseCodesign('code object is not signed at all')).toEqual({ kind: 'unsigned' })
  })

  it('finds the .app bundle a binary lives inside, and nothing when it is not in one', () => {
    expect(macBundleRoot('/Applications/PureScience.app/Contents/MacOS/PureScience')).toBe(
      '/Applications/PureScience.app'
    )
    expect(macBundleRoot('/Users/x/repo/node_modules/electron/dist/Electron')).toBeUndefined()
  })

  it('reports an ad-hoc macOS build with Gatekeeper’s own verdict and the way past it', async () => {
    const exec = vi.fn(async (command: string) => {
      if (command === 'codesign') return { stdout: '', stderr: 'Signature=adhoc' }
      throw Object.assign(new Error('rejected'), {
        stdout: '',
        stderr: '/Applications/X.app: rejected'
      })
    })

    const result = await checkSignature({
      command: '/Applications/X.app/Contents/MacOS/X',
      platform: 'darwin',
      exec,
      exists: () => true
    })

    expect(result).toMatchObject({
      state: 'adhoc',
      gatekeeper: 'rejected',
      detail: MAC_FIRST_LAUNCH
    })
  })

  it('reports a Developer ID build as identified instead of asking the user to click through', async () => {
    const exec = vi.fn(async () => ({
      stdout: '',
      stderr: 'Authority=Developer ID Application: Example GmbH (ABCD123456)'
    }))

    const result = await checkSignature({
      command: '/Applications/X.app/Contents/MacOS/X',
      platform: 'darwin',
      exec,
      exists: () => true
    })

    expect(result).toMatchObject({
      state: 'developer-id',
      authority: 'Developer ID Application: Example GmbH (ABCD123456)'
    })
    expect(result.detail).not.toBe(MAC_FIRST_LAUNCH)
  })

  it('reports an unsigned Windows binary with the SmartScreen way past it', async () => {
    const exec = vi.fn(async () => ({ stdout: 'NotSigned\n', stderr: '' }))

    const result = await checkSignature({
      command: 'C:\\Program Files\\PureScience\\PureScience.exe',
      platform: 'win32',
      exec
    })

    expect(result).toMatchObject({
      state: 'unsigned',
      status: 'NotSigned',
      detail: WINDOWS_FIRST_LAUNCH
    })
  })

  it('separates a hash mismatch from "not signed" on Windows', async () => {
    const exec = vi.fn(async () => ({ stdout: 'HashMismatch\n', stderr: '' }))

    const result = await checkSignature({
      command: 'C:\\x\\PureScience.exe',
      platform: 'win32',
      exec
    })

    expect(result.state).toBe('invalid')
  })

  it('names Linux as "no such layer" rather than as an unsigned build', async () => {
    const result = await checkSignature({ command: '/usr/bin/purescience', platform: 'linux' })

    expect(result.state).toBe('not-applicable')
  })

  it('says nothing was measured when there is no binary to look at', async () => {
    expect(await checkSignature({ platform: 'darwin' })).toMatchObject({ state: 'unknown' })
  })
})

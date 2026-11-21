import { describe, expect, it } from 'vitest'

import { ocrInstallCommand } from './ocr-install-command'

// 这条映射是被一次真机读数逼出来的：Windows runner 上跑 P0，缺 tesseract 时弹的提示让用户
// 「brew install tesseract」—— 那台机器上没有 brew。断言写成「命令与平台一致」而不只是「非空」，
// 否则把 brew 留给 Windows 也会通过。
describe('ocrInstallCommand', () => {
  it('names a package manager that exists on the platform', () => {
    expect(ocrInstallCommand('win32')).toBe('winget install UB-Mannheim.TesseractOCR')
    expect(ocrInstallCommand('darwin')).toBe('brew install tesseract')
    expect(ocrInstallCommand('linux')).toBe('sudo apt install tesseract-ocr')
  })

  it('never hands a macOS-only command to another platform', () => {
    for (const platform of ['win32', 'linux', 'freebsd']) {
      expect(ocrInstallCommand(platform)).not.toContain('brew')
    }
  })

  it('says just the program name when the platform is unknown', () => {
    // 编一条可能不存在的包管理器命令，比说「装 tesseract」更糟。
    expect(ocrInstallCommand('aix')).toBe('tesseract')
  })
})

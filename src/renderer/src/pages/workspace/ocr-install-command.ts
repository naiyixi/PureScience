// 缺 tesseract 时那条提示要给出「在你手上这台机器上真能跑」的命令。
// 原先九种语言都写死 `brew install tesseract` —— 在 Windows 上等于让用户去装一个没有的东西。
// 这是 2026-11-21 打开 Windows 车道跑 P0 时从真窗口抓到的：那台机器上弹的正是「请装 brew」。
export const ocrInstallCommand = (platform: string): string => {
  if (platform === 'win32') return 'winget install UB-Mannheim.TesseractOCR'
  if (platform === 'darwin') return 'brew install tesseract'
  if (platform === 'linux') return 'sudo apt install tesseract-ocr'
  // 未知平台不编命令：说清「装 tesseract」比给一条可能不存在的包管理器命令更诚实。
  return 'tesseract'
}

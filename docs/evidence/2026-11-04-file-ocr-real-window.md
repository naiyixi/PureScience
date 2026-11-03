# 图片取字的真机读数（认证规格 `e2e/certification/file-ocr.spec.ts`）

- 时间：2026-11-04 07:5x CST（本机 macOS，tesseract 5.5.0 + `eng.traineddata`）
- 被测提交：`3bbe25e0`（工作区另带他人在制改动，一律未纳入本笔）
- 产物：先 `npm run build:e2e`（`NODE_OPTIONS=--max-old-space-size=8192`，`✓ built in 22.98s`，`out/main/index.js` 07:50 重建）——e2e 实例加载的是这次构建的包，不是上一次的
- 命令：`npx playwright test e2e/certification/file-ocr.spec.ts --reporter=list`
- 判决：`1 passed (9.6s)`，退出码 0；改过格式（eslint `--fix` 只动换行）之后**再跑一次**仍
  `1 passed (8.6s)`，出处句 `in 91 ms` —— 两次连续绿，不是一次运气

## 一 这一轮真的走到的分支

规格把「识别到正文」与四类具名失败（缺引擎 / 缺语言包 / 该界面语言没有包 / 文件读不了）都算诚实的结局，但**必须把实际分支打印出来**，
否则一次从未到达引擎的运行会被读成识别可用。本机拿到的是正向那支：

```
[ocr-cert] rendered=true branch=text dialog="Recognised text lab-scan.png × Read with eng.traineddata
(tesseract eng) in 95 ms. This text came from an image, not from a text layer.
HEMOGLOBIN 12.4 g/dL PLATELETS 210 K/uL"
[ocr-cert] provenance="Read with eng.traineddata (tesseract eng) in 95 ms. This text came from an image,
not from a text layer."
```

- 正文明文包含夹具印上去的两项：`HEMOGLOBIN`、`12.4`（tesseract 自己的读法，不是测试塞进去的字符串）
- 出处句三要素齐：包名 `eng.traineddata`、引擎与语言 `tesseract eng`、耗时 `95 ms`，并明说「来自图像，不是文本层」
- 主进程侧同一笔有读数：`[ipc] ipc handler was slow { channel: 'pdf:ocr', surface: 'electron', durationMs: 144.89, cpuMs: 11, cpuShare: 0.076, attribution: 'no-cpu-in-process' }`
  —— 通道是真走桥接的（不是渲染层替身），且 7.6% 的 CPU 占用说明识别确实发生在外部进程里

## 二 规格自己守的四条

1. **正向**：面板出现正文，且出处句含包/引擎/耗时（见上）
2. **反向对照**：同一个面板里的 `lab-notes.md` 不出现「识别文字」按钮，`[data-slot="file-ocr-action"]` 在全面板恰好 1 个
   ⇒ 按钮是图片的属性，不是面板的属性
3. **绝不空框**：六个结果节点（正文/无字/缺引擎/缺语言包/无该语言包/读不了）里**恰有一个**可见，用「正条件计数」判，
   而不是等「正在读取」那行消失
4. **焦点归还**：面板由页面状态打开、没有 `Dialog.Trigger`；`Escape` 关闭后 `document.activeElement` 的 `aria-label`
   必须回到「Read text from lab-scan.png」（否则键盘读者被丢到文档顶部）

## 三 图片是怎么进 Files 面板的（这条是本轮真正解决的那一格）

不是造 artifact，而是走读者自己的路：两张文件（一张渲染出的 PNG 扫描页 + 一个 markdown 备注）经 composer 的
文件选择器 `input[type="file"][multiple]` 附上，随那一轮发送后落进项目文件索引，Files 面板才看得到它们。
扫描页由 `cupsfilter` 印成 PDF、再用 `sips` 转 PNG（两个都是系统自带，仓里不放二进制）；两者不可用时退回 1×1 PNG
并在日志里写明 `rendered=false`，此时只走「无字/失败」那一侧，不假装印出了页面。

另一处：composer 只对「声明接受图像」的模型给图片入口，而夹具的假 agent 建 provider 时没开这个标志。
规格通过应用自己的 `settings:upsertProvider` 把 `supportsImageInput` 打开（`baseUrl`/`model`/密钥从既有记录继承，
不能给假的），被测的取字路径一个字节没改。

## 四 还没取到的读数（具名）

- **CI 的 macos-arm64 车道有没有 tesseract 未知** ⇒ 该车道可能落到「缺引擎」那支。规格两种都接受并把分支打进日志，
  真正的判决要等这次推送后 Nightly 的 P0 认证作业给出（本文件写下的只有本机读数）。
- 本机是 8 GB、swap 已用 6.0 GB 的机器，9.6 s 的耗时不能当性能基线读。

## 五 收尾复核

- e2e 实例已全部退出：`ps` 里没有 `purescience-electron-e2e` 进程
- 夹具的临时根 `/var/folders/…/purescience-electron-e2e-*` 已被它自己删掉（`ls` 无匹配）
- 真实配置根 `~/.purescience-project` 的 mtime 仍是 `Nov  3 22:48`，本轮没有写入
- `git status --short` 里本笔只新增本文件与规格；其余改动属于并行会话的在制品，未暂存、未提交

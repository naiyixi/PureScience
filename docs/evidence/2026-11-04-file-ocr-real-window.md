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

## 六 车道判决（2026-11-04 12:xx 读，绑到 `bed955ef`）

| 项 | 读数 |
| --- | --- |
| Run | `Nightly` run `41742969126`（`Windows Full Test` run `41742968969`：success） |
| 作业 | `build / Verify` success、`Build windows-x64`/`linux-x64`/`macos-x64` success、**`Build macos-arm64` failure**、`publish` skipped |
| 汇总行 | `1 failed` / `2 flaky` / `12 skipped` / `113 passed (35.7m)` |
| 唯一失败 | `e2e/certification/file-ocr.spec.ts:51` —— `locator.click: Timeout 30000ms exceeded`，`element is not enabled` |
| 另两条 flaky | `connector-custom-sign-out`（`Electron app never opened a window`，重试转绿）、`pdf-annotation-overlay-pane`（`the pane changed width between the two readings`，273 ≠ 423，重试转绿） |

**实际分支不是「缺引擎」，而是根本没走到引擎**：失败截图里 `lab-scan.png` 与 `lab-notes.md` 两张上传磁贴都带
`MISSING` 角标、动作按钮全部灰掉（`test-results/electron/certification-file-ocr-rea-…/test-failed-3.png`）。

### 根因（file:line）

`artifacts.probeAvailability` 在处理上传时把 `upload-version:<project>/<session>/<version>` 这个**定位符**
交给了 artifact 根路径解析器（`src/main/artifacts/ipc.ts` 的 `repository.resolveManagedFilePath`），
而上传物住在 `uploads/` 根下、只有上传仓库答得出来 ⇒ 每条上传都被判「不可用」⇒
`ProjectFilesView` 的 `useUnavailablePreviewProbe` 把 `missing` 置真 ⇒ 磁贴打 `Missing` 角标、
`FileOcrAction` 与下载/分栏三个动作一起 `disabled`。

这是**产品缺陷，不是测试缺陷**：读者自己的上传在文件面板里既读不出也下不了。
修复（`resolveUploadPath` 依赖 + 在 `src/main/ipc.ts` 的装配点接线）**已存在于并行会话的工作区、尚未提交**，
本笔一个字节没有碰它。

### 本笔能做的那一半：断言不能早于答案

旧断言在面板刚打开时就 `toHaveCount(0)` / `toBeEnabled()` —— 探针是异步的、在答案回来之前磁贴读作「可用」，
于是断言当场通过、几秒后 `click()` 撞在已被 `disabled` 的按钮上，**失败信息只剩一句 30 s 超时**。
（本机上一轮之所以「通过」，是探针答案比点击晚到 —— 同一份代码的两种时序。）

改法（只紧不放）：面板可见后先给探针一个记账窗口，**角标一旦出现立即**以具名句失败；
干净磁贴才继续，并在点击前再断言一次「无角标 + 可用」。两处都用应用自己的文案常量 `Missing`，不新增选择器。

### 两向实跑（同一棵主树代码，只动被还原的那两个文件）

| 场景 | 命令 | 读数 |
| --- | --- | --- |
| 带并行会话的上传修复 | `npx playwright test e2e/certification/file-ocr.spec.ts --reporter=list`（`✓ built in 30.85s`） | **1 passed (18.7s)**，`[ocr-cert] tile=ready`，`branch=text`，出处句 `in 108 ms`，正文含 `HEMOGLOBIN`/`12.4` |
| 把 `src/main/ipc.ts` 与 `src/main/artifacts/ipc.ts` 还原到 `bed955ef` | 同上（`✓ built in 30.64s`） | **1 failed**，`[ocr-cert] tile=missing`，失败句即上面那条具名解释 —— 缺陷在本机也复现，**不是车道独有** |

### 边界（不许读成更强）

- 本笔只改认证规格与其失败信息；**上传被误判为缺失这个产品缺陷仍未修**，修在并行会话手里。
  因此这次推送后车道预期仍红，但红的理由会是我写的具名句，而不是一句 30 s 超时。
- `macos-arm64` 车道有没有 tesseract 仍未知：修复落地后才第一次真正到达引擎，届时看 `[ocr-cert] branch=` 那一行。
- 两条 flaky 只按「重试转绿」记档，未做多遍 isolation 定性；它们与本笔无交集。


### 车道读数（2026-11-05 补：那条「未知」现在有答案了）

上面「`macos-arm64` 车道有没有 tesseract 仍未知」这一条，按该轮写下的取法读到了：

| 项 | 读数 |
| --- | --- |
| 车道 | `Nightly` run `41969799634` / 作业 `build / Build macos-arm64`（job `127059347603`），提交 `4a369a9e`，**success** |
| 规格行 | `e2e/certification/file-ocr.spec.ts`：`✓` 通过，`117 passed / 1 flaky (29.9m)` |
| 实际分支 | `[ocr-cert] tile=ready before the read` → `[ocr-cert] rendered=true branch=tool-missing dialog="Recognised text lab-scan.png × Reading images needs the tesseract program. Install it (brew install tesseract) and try again."` |

⇒ 三条都清楚了：① 车道**没有** tesseract，规格落到的是「缺引擎」那一支，属于**具名失败**而不是空框；
② 上传探针的修复在车道上也生效了（`tile=ready`，磁贴不再被判 Missing）；③ 「绝不空框」那条断言在车道上
真的跑了（对话框里是那句解释，不是一个空壳）。不影响本档前面「本机走的是 `branch=text`」那条读数 ——
两侧是同一支规格在不同环境下的两个诚实分支。

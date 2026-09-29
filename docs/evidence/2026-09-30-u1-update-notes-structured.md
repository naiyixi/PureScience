# 更新说明结构化（U1 / issue #17）：真机实测（分组标题 / 编号条目 / 条目内小标题 / 按钮体积 / 中文最长不破版）

- 日期：2026-09-30
- 实例：**真 Electron 应用**（`npx electron-vite build` 产物 `out/main/index.js` + 真渲染器），由 Playwright 驱动，窗口 1280×804 @2x
- 用例：`e2e/update-release-notes.spec.ts`（`--retries=0 --repeat-each=2`）
- 采集来源：`docs/evidence/2026-09-30-u1-update-notes-metrics.json`（用例每次跑完重写，数字由**真浏览器测量**，不是估算）
- 截图：`2026-09-30-u1-update-notes-zh.png`（整窗，中文界面）· `2026-09-30-u1-update-notes-zh-surface.png`（说明区滚到底，看 2000 字不可断行 token 的换行）

## 一、唯一被替换的缝

更新检查在**主进程**用 Electron `net.fetch` 拉 `version.json`，页面级路由拦不到，且「下一版的真 manifest」此刻并不存在。用例因此只替换**这一个响应体**（`app.stubUpdateManifest(manifest)`，fixture 里的 `net.fetch` 只对 `/version.json` 生效、其余请求原样放行）。这之后的每一段都是发布代码：真 `UpdateService` → 真 `update:status` 广播 → 真 renderer store → 真对话框 → 真 Chromium 布局。

流程也是真的：设置 → 通用 → **立即检查** → **更新到 1.99.0** → 在真语言选择器里切到简体中文 → 打开对话框。

## 二、判据对照

| 判据 | 实测（真机） | 结论 |
|---|---|---|
| **R1 不丢内容**（未知语法原样显示） | `> 未知语法（引用块）原样显示` · `\| 表头 \| 值 \|` · `结尾纯文本` 三条都出现在真机 DOM；渲染不了的行没有任何一条被吞掉 | ✅ |
| **R1 不丢内容**（超长行整条在渲染里） | 2010 字不可断行 token **完整**出现在 DOM（`characters: 2010`），不是截断后的前缀 | ✅ |
| **R2 体积真实** | manifest 给 mac-arm64 报 **7,864,320 B** ⇒ 按钮显示 **`下载更新（7.5 MB）`**；其余三平台（9.0 / 10.0 / 11.0 MB）**一个都不出现**（用例逐个断言 not.toContainText） | ✅ |
| **R2 拿不到就不显示** | 单测：`totalBytes` 为 `undefined / 0 / NaN` 时按钮文案回落 `Download update`，正文不含 `MB` | ✅ |
| **R2 数字随语言** | 真机中文 `7.5 MB`；单测 de/ru ⇒ `12,5 MB`（逗号小数），zh/en ⇒ `12.5 MB` | ✅ |
| **R3 不破版**（横向不溢出） | 说明区 `scrollWidth 518 = clientWidth 518`；对话框 `scrollWidth 558 = clientWidth 558`；说明区**所有后代**最右沿比容器右沿还左 **11.8 px**（`widestRight: -11.8`） | ✅ |
| **R3 不破版**（不截断） | `text-overflow: ellipsis` 节点 **0** 个；`overflow: hidden` 节点 **0** 个；2000 字 token **折成 27 个行盒**、最右 884.6 ≤ 容器右沿 897.0 | ✅ |
| **R3 不破版**（下载按钮不出框） | 按钮右沿 895.5 ≤ 对话框右沿 916.2（中文文案 + 最长体积一起） | ✅ |

## 三、复现命令与输出尾部

```
$ NODE_OPTIONS=--max-old-space-size=6144 npx electron-vite build
✓ built in 20.80s
BUILD_EXIT=0

$ NODE_OPTIONS=--max-old-space-size=4096 npx playwright test e2e/update-release-notes.spec.ts --retries=0 --repeat-each=2
Running 2 tests using 1 worker
  ✓  1 e2e/update-release-notes.spec.ts:89:5 › the update dialog structures its notes, keeps unknown syntax, and shows the real download size (6.6s)
  ✓  2 e2e/update-release-notes.spec.ts:89:5 › the update dialog structures its notes, keeps unknown syntax, and shows the real download size (4.6s)
  2 passed (11.8s)
E2E_EXIT=0
```

（本机不跑 `build:unpack` / `electron-builder`；真机车道只走 `electron-vite build` + Playwright，且**串行**——同一时刻只有一个 Electron 实例。）

## 四、说明

- 纵向滚动是**设计内**：说明区 `max-h-96`（客户端高度 384、内容高 741），内容可达、不截断；本档只把**横向**溢出钉死为 0。
- 本轮不引渲染库：`src/renderer/src/lib/release-notes.ts` 是自写的受控子集解析器（标题 / `-` 列表 / `**加粗**` / 行内代码 / 裸提交短 SHA），解析不了的一律原样成段。
- 分组标题：说明里写了 `#` 标题就照用；作者没写标题的那一组，用对话框自己的文案 `update.notesHighlights`（×9 语言）标注。
- 体积数字仍是「更新器报的那个数」（manifest `download.size` / electron-updater 的 artifact size）；本档只改了小数分隔符随语言。

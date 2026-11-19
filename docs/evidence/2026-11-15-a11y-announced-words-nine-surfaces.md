# 控件「念出来的那句话」也是英文：九个面的 aria-label / 提示语收进九语字典

日期：2026-11-15（执行器）
提交：本笔（`fix(renderer)` 系列第三批）

## 一 缺陷形状

上一批把**看得见的状态词**从字面量收进字典（§三百三十八），但同一个缺陷还有第二种载体：
**控件对外念出来的那句话**。

- `aria-label`：读屏软件念的那句。中文界面里它仍是 `Copy message` / `Destroy context` /
  `Model provider: …` ⇒ 一个中文用户开读屏只听得到英文。
- `tooltip` / 行标签：`TooltipContent`、`label={…}` 里的同一句，鼠标悬停时**上屏可见**，也是英文。

两种载体都藏在「表面上已经翻好了」的组件里：可见正文走 `t()`，而 `aria-label`/`title` 直接写了字面量，
所以既有的 i18n 门禁（扫可见正文、扫「中文值等于英文值」）一处都不报。

## 二 本笔改了什么

九个面（13 个组件文件）：

| 面                                                        | 改前                                                       | 改后                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 工具代码块复制键                                          | `'Copied' / 'Copy code'`                                   | `a11y.copied` / `a11y.copyCode`                                              |
| notebook 代码块复制键                                     | `'Copy to clipboard'`                                      | `a11y.copyToClipboard`                                                       |
| 上下文用量（压缩键 + 环形图）                             | `'Compact context' / 'Context used' / 'Estimated context'` | `a11y.compactContext` / `a11y.contextUsed` / `a11y.estimatedContext`         |
| 消息项（复制键 + 模型胶囊）                               | `'Copy message'`、`` `Model provider: ${name}` ``          | `a11y.copyMessage` / `a11y.modelProvider(WithModel)`                         |
| 设置页展开/收起                                           | `'Maximize' / 'Restore'`                                   | `a11y.maximize` / `a11y.restore`                                             |
| 本地文件浏览器书签键                                      | `'Pin this folder' / 'Remove bookmark'`                    | `a11y.pinFolder` / `a11y.removeBookmark`                                     |
| 计划预览全屏键（`aria-label` 与 `TooltipContent` 各一份） | `'Enter / Exit full screen'`                               | `a11y.enterFullScreen` / `a11y.exitFullScreen`                               |
| 外链安全弹窗                                              | `aria-label="Open external link?"`                         | `a11y.openExternalLink`                                                      |
| 项目表单关闭键 / 通用面板                                 | `'Close'`、`label="Theme"`、mac 之外那句回退文案           | 既有键 `common.close` / `settings.theme` + 新增 `settings.themeFallbackHint` |
| 连接器工具权限行                                          | `` `Permission for ${method}` ``                           | `settings.connectorToolPermission`（带插值）                                 |
| 专家编辑器移除键                                          | `` `Remove ${name}` ``                                     | **既有键** `aria.removeItem`（带插值，不新造第二份）                         |

新键 20 个（`a11y.*` 17 个 + `settings.*` 2 个）在九份字典里齐全；`en` 与 `zh` 值不同形。

## 三 守卫（第二类载体）

`src/renderer/src/i18n/status-wording-guard.test.ts` 的 `SURFACES` 从 6 个面扩到 14 个面，双向仍是两条：
该印的 key 必须被引用；这些 key 的**英文值**不得作为字符串字面量出现在该文件里（注释先剥离）。

`aria.removeItem` 这条走既有键而不是新键，是刻意的：同一个「移除 <名字>」的说法已经有一份，
再建一份等于第二个词汇，日后两处会漂。

## 四 门禁（本机实跑，改动覆盖的全部目录）

| 环                                                                                                      | 读数                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 定向 vitest（`i18n` + `pages/workspace` + `pages/settings` + `pages/home` + `components/streamdown`）   | 270 files / 2812 passed、1 skipped，exit 0 |
| 双 typecheck（`typecheck` = node + web，`--composite false`，`NODE_OPTIONS=--max-old-space-size=8192`） | node 0 / web 0                             |
| `npx eslint --no-cache`（本笔全部 22 个改动文件）                                                       | 0 problems（exit 0）                       |

## 五 边界与具名未办

- 只覆盖「属性值是**字面量**」。**带插值的模板串**里夹的英文词（`` `${label} runtime` ``、
  `` `${grants.length} allowed this session` ``、`` `${name} scrollable preview` ``、
  `` `${step.title} status: …` ``、`` `${t(…)} parent directory` ``、`` `${t(…)} repositories` ``）
  是同一族的下一批，本轮已实测到 7 处，作为**下一单元**立案（不在本笔里半改）。
- 不在渲染层的载体（原生菜单项、系统通知标题、toast 标题）本笔未普查。
- `scripts/i18n-hardcoded-audit.mjs` 对这两类形状仍 0 命中（它读的是可见正文与 JSX 文本），
  与上一轮同结论：需要语义判据，不硬塞进该脚本。
- 无真机窗口读数：本笔不新增数据路径，取证 = 真 `LanguageProvider` 渲染套件 + 上述门禁；
  装机版随下一次发版生效。

## 六 下一轮第一步

插值模板串那 7 处（见 §五第一条），以及 `title=` 之外的第三类载体（原生菜单项 / 系统通知标题）。

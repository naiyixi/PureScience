# 两个原生对话框的九语文案（数据搬迁中途的退出确认 / 渲染进程反复崩溃的恢复提示）

日期：2026-11-16（执行器）｜提交：本笔

## 1 为什么这是缺陷，不是打磨

这两处弹窗是**主进程自己画的原生对话框**，没有渲染器 i18n provider 可读：

| 弹窗 | 何时出现 | 改动前的文案 |
|---|---|---|
| 数据根搬迁中途按 ⌘Q / 关窗 | 用户刚点了「移动数据」，搬迁正在进行 | `Move in progress` / `Keep waiting` / `Quit anyway` + 一段长说明（全英文） |
| 渲染进程反复崩溃，自动恢复已暂停 | 窗口反复变白，用户正看着一个空窗口 | `Reload` / `Close window` + 两段说明（全英文） |

两处都出现在**用户必须在压力下做决定**的时刻：前者选错就中断一次搬迁（数据不会坏，但要重来），
后者选错就关掉一个可能还想看一眼的窗口。读者读的是八种语言中的一种，却只拿到英文按钮 —— 这不是外观问题。

同一仓里已有成套机制（`src/main/native-locale.ts`：`NativeLocaleCode` 九语 +
`nativeStringsFor(map)` + `Record<NativeLocaleCode, T>` 类型门），配对页 / OAuth 回跳页 /
关窗确认弹窗都已接上；这两处是漏网的。

## 2 交付

| 文件 | 改动 |
|---|---|
| `src/main/native-dialog-strings.ts`（新） | 两张 `Record<NativeLocaleCode, …>` 表：`MIGRATION_QUIT_STRINGS`（5 字段 × 9 语）、`RENDERER_RECOVERY_STRINGS`（4 字段 × 9 语）。英文值与改动前的字面量**逐字节相同** |
| `src/main/storage/migration-state.ts` | 新增导出的纯函数 `migrationQuitDialogOptions()`（按钮顺序 = 安全项在前，且 `defaultId=cancelId=0`，误按 Return/Escape 不会中断搬迁）；`defaultConfirmQuit` 改为调它 |
| `src/main/windows.ts` | 新增导出的纯函数 `rendererRecoveryDialogOptions()`（`defaultId=0` 重载、`cancelId=1` 关窗）；`render-process-gone` 处理器改为调它 |

产品名 `PureScience` 在九语里都不翻（与关窗确认弹窗同一口径）。

**为什么抽成导出的纯函数**：原生对话框没有任何可断言的渲染输出。抽出来之后，测试能拿**真的那个构造函数**
（而不是复制一份选项字面量）逐语跑一遍，断言「解析到的语言 = 按钮上真正的语言」。

## 3 门禁（本机实跑）

| 环 | 读数 |
|---|---|
| 定向 vitest（新表 + `migration-state` + `windows`） | 3 files / **70 passed**，exit 0 |
| 双 typecheck（`--composite false`） | node **0** / web **0** |
| `npx eslint --no-cache`（本笔 6 个文件） | **0 error / 0 warning** |
| 全量 vitest `--maxWorkers=4` | **1482 files passed**、31 skipped（共 1513）；**18574 passed**、228 skipped（共 18802），exit 0（上轮基线 1481 / 18561 ⇒ +1 文件） |

### 3.1 变异自证（证明这三道门真的会红）

对实现与表各做一次变异，跑同一批用例，三处**各自**红，随后还原并复跑回全绿：

| 变异 | 红在哪 |
|---|---|
| `migration-state.ts` 里把 `title: s.title` 换回字面量 `'Move in progress'` | ① 静态守卫 `storage/migration-state.ts carries no English dialog literals`；② 行为用例 `carries no English sentence once the OS language is one of the other eight`（`title` 仍是英文） |
| `RENDERER_RECOVERY_STRINGS.zh.reload` 改成英文 `Reload` | 表纪律用例 `never repeats the English value in another language` |
| 还原后复跑 | 3 files / 70 passed |

## 4 边界与具名未办（诚实口径）

- **没有真机窗口读数，也不可能有**：这两个对话框只在「OS 语言 = 某一种 + 事件真的发生」时出现
  （搬迁中途按 ⌘Q / 渲染进程在 60 s 内崩两次以上）。本机取证做到的是**真 `app.getLocale()` 级联 + 真选项构造函数**
  逐语跑（含 `pt-BR` 这类未发布语言回落英文），不是「在屏幕上看见中文弹窗」。装机版随下一次发版生效。
- **非英文行的译文由我写，没有母语审校**：ja/ko/es/de/fr/ru/zh/zh-Hant 八行是我按语义翻的，术语与语气对齐既有
  `window-close-confirm.ts` 的表（同族同风格）。`zh-Hant` 已用「简体独有字符」清单静态扫过（`实/数/据/动/开/关/复/载/应/让/会/时/间/这` 零命中），
  这是探测器不是校对。
- **本单元只覆盖这两处**：`app-menu.ts` 的 About 弹窗（title/message 就是应用名 + 版本号，无需翻译）、
  托盘菜单（`src/main/index.ts:719` 已按 `app.getLocale()` 取 `trayLabelsForLocale`）、关窗确认（已有九语表）都在本单元之外。
- 边角：`migrationQuitDialogOptions()` 的 `type: 'warning'` 与 `rendererRecoveryDialogOptions()` 的 `type: 'error'`
  保持不变（图标语义与是否出音由平台决定，不是文案）。

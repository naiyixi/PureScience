# 状态词的第二批：同一个形状散在六个面里，其中一个是「颜色按翻好的词判」

日期：2026-11-15（执行器轮次 §三百三十八）

## 一 症状与判据形状

上一轮（§三百三十七）把远端作业那一族的四个组件收进同一支 `jobStatusLabel()`。本轮按那一笔自己的
静态守卫**反向扫**，看还有哪些面在「自己拼状态词」——判据不是「读起来像没翻」，而是**这个词从哪来**：

| 面 | 原写法 | 读者看到什么 |
|---|---|---|
| `pages/workspace/WorkspaceSidebar.tsx` | `Record<SessionStatus, string>` = `Idle / Running / Waiting for permission / …` | 会话行的读屏句 `Session status: Idle`（中文界面里读屏念英文） |
| `components/NotificationBell.tsx` | `actionLabel(item)` 六条 `if` 各返回一串英文 | 消息中心每一行的动作词 `Needs approval / Resolved` |
| `components/NetworkStatusIndicator.tsx` | 三元表达式里两串英文 `Offline / Unreachable` | 首页头部那颗网络胶囊（邻居全是译文） |
| `components/environment-check-row.tsx` | `STATUS_COPY = { passed: 'Ready', … }` | 入职引导的环境步骤 + 设置里网络面板的状态胶囊 |
| `pages/workspace/SpecialistSubmenu.tsx` | `'Unavailable'` / `'None'` | 输入框旁边专家胶囊的回退字 |
| `pages/workspace/previews/preview-errors.ts` | `FILE_MISSING_TAG = 'Missing'`（常量，被三处读） | 文件瓦片左上角的 `MISSING` 角标 |
| `pages/settings/RemoteControlPanel.tsx` | 样式按**翻好的词**判：`statusLabel === 'Connected'` | 中文界面的「已连接」徽章**没有**高亮（只有英文界面会亮） |

最后一条是这一族里第二种形状：**写侧有译文、读侧拿译文当状态判**。它不会像硬编码那样一眼看出来，
因为屏上每个字都对——错的是「中文下永远不成立」的那次比较，而颜色是唯一的读数。

同一批还清掉两处死代码：`preview-errors.ts` 里的 `FILE_MISSING_MESSAGE` /
`FILE_OUTSIDE_STORAGE_MESSAGE` 两个长句**全树无消费方**（打开视图读的是 `ws.fileUnavailable` /
`ws.previewUnavailable`），留着就是第二份口径。

## 二 改动

| 位置 | 改动 |
|---|---|
| 九语字典 ×9 | 新 20 键：`sessionStatus.*`(6) / `notificationAction.*`(8) / `network.*`(4) / `environmentStatus.review|actionNeeded|waiting`(3) / `modelPicker.unavailableFor` / `preview.missingTag`；`Ready` 复用既有 `common.ready`，`Unavailable`/`None` 复用既有 `specialist.unavailable`/`ws.none` |
| 六个渲染面 | 手写英文词改成取字典；`FILE_MISSING_TAG` → `FILE_MISSING_TAG_KEY`（常量改成 key，三处消费点各自 `t()`） |
| `RemoteControlPanel.tsx` | 新增 `providerIsConnected(snapshot)` 谓词，**标签与样式同取一处事实**：`statusClassName` 不再比较译文；`statusLabel` 走同一谓词 |
| `pages/workspace/WorkspaceSidebar.tsx` | 状态表改成 `Record<SessionStatus, TranslationKey>` + `sessionStatusLabel(status, t)`；联合外历史值原样显示（不 `t(undefined)`） |
| `i18n/status-wording-guard.test.ts`（新） | 6 个面 × 双向：每个该印的 key 必须被**引用**、这些 key 的英文值不得作为**字面量**出现在该文件里；注释先剥离（注释里点名它替掉的词是想要的文档，不是缺陷） |
| `RemoteControlPanel.render.test.tsx` | 新 1 条：中文 provider 下渲染已连接快照，徽章仍必须带 `bg-primary/10` |

## 三 读数

- 守卫的变异自证：把 `RemoteControlPanel.tsx` 的样式判据改回 `statusLabel === 'Connected'`，
  新用例当场红（`expected 'group/badge inline-flex …' to contain 'bg-primary/10'`），改回即绿 —— 这条用例
  真的在守那一行，不是同形复述。
- 门禁读数见下节（本机实跑）。

## 四 门禁（本机实跑，改动的全部文件）

| 环 | 读数 |
|---|---|
| 定向 vitest（`src/renderer/src/i18n` + `src/renderer/src/components`） | 73 files / 616 passed |
| 定向 vitest（`RemoteControlPanel.render` + `status-wording-guard`） | 2 files / 7 passed（变异后 1 failed） |
| 双 typecheck（`--composite false`） | node 0 / web 0 |
| `npx eslint --no-cache`（本笔全部改动 + 新测试） | 0 error / 0 warning |
| 全量 vitest `--maxWorkers=4` | **1481 files passed、31 skipped（共 1512）；18561 passed、228 skipped（共 18789）**，exit 0（基线 1480/18556 ⇒ +1 文件 +5 例，正是本笔新增的守卫文件与其用例） |

## 五 边界与具名未办

- 只覆盖「字面量写在组件里」与「颜色按译文判」两种形状；**没覆盖**的：`aria-label` 已走字典但
  `title=` 仍是英文的组件（未普查）。
- 审计器 `scripts/i18n-hardcoded-audit.mjs` 对这一族仍报 0 命中（形状是对象字面量的 value 与三元表达式），
  与上一轮同一结论：需要语义判据，不是正则 —— 仍立案，不硬塞。
- 无真机窗口读数：本笔不新增路径/数据，取证 = 真 `LanguageProvider` 渲染 + 全量门禁；装机版随下一次发版生效。

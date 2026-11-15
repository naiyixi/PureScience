# 任务完成通知只留一个生产者（2026-11-16）

## 〇 开工核对（防重做 + 并发 + 该谁做）

- 上一笔 `fcc93101`（系统文件面板九语）本轮已推；`origin/main = fcc93101`。工作树只有三份不是我的未跟踪证据档。
- 本单元不是重做：全树 `grep "notifyTurnOutcome"` 只命中 `prompt-turn-workflow.ts` 的调用点与模块自身，
  没有任何提交在改通知通道（`git log --oneline -15` 全是 i18n 面）。
- 开工前先跑了一遍「唯一生产者」的判据（`grep -rn "new Notification(\|notificationCtor("`）：**两处**。

## 一 缺口形状：同一个事件有两个生产者，其中较弱的那条绕过三道门

| | 收件箱服务（保留） | 回合工作流附带的那条（删除） |
|---|---|---|
| 设置开关 `notificationsEnabled` | **有**（`isEnabled`） | 无 |
| 应用在前台就不弹 | **有**（`isAppFocused`） | 无 |
| 无头 `--serve` 守护进程不弹 | **有**（`buildTaskNotificationShow` 的 `if (deps.headless) return`） | 无 |
| 点通知回到那个会话 | **有**（`setActivationHandler`） | 无 |
| 未读计数 / 收件箱卡片 | **有**（`setUnreadHandler`、`notificationInbox.record`） | 无 |
| 正文语言 | 规范英文，渲染层按界面语言映射 | 硬编码一种语言（`任务已完成` / `任务执行失败`） |
| 触发条件 | 用户发起的回合 + 未聚焦 + 设置开启 | **每个回合结束无条件** |

同一件事写两遍，弱的那份就会被当成「反正也能弹」而活下来——这次它活到了「关掉通知照样弹、
前台盯着屏幕也弹、无头守护进程也弹、且在另外八种界面语言下弹一段中文」。

## 二 实跑读数（先取证、再动手）

**装机版真实日志**（用户本机 `~/Library/Logs/PureScience/main.1.log`，2026-11-06…11-09 那一段）：

```
{"t":"2026-11-07T16:03:01.102Z","level":"info","scope":"notifications","msg":"delivering task notification","data":{"title":"Task completed","supported":true}}
{"t":"2026-11-09T09:41:51.047Z","level":"info","scope":"notifications","msg":"delivering task notification","data":{"title":"Task completed","supported":true}}
```

⇒ 收件箱服务这条**在真实装机上确实投递过**（两次）。另一条没有被删前的日志（这本身是它的
一处可观测性缺口，已在具名未办里记下），所以「同一回合弹两次」不能从日志里数出来——它的必然性
来自代码形状：`prompt-turn-workflow.ts` 在每个回合的 `finally` 之后**无条件**调它，而服务的投递需要
「用户发起 + 未聚焦 + 设置开启」三道门同时成立 ⇒ 服务投递的那两个回合（未聚焦）必然也走了这条。

本单元**不声称**在屏幕上看见了两个横幅：OS 通知中心由系统绘制，Playwright 抓不到，本机也没有第二台
机器复核。判据是「两处构造点 + 一处没有门」，不是「我数到了两条日志」。

## 三 交付

| 位置 | 改动 |
|---|---|
| `src/main/notifications/turn-notifications.ts` | **删除**（全树唯一消费者是下面那一行） |
| `src/main/acp/prompt-turn-workflow.ts` | 去掉 import 与该调用（回合收尾只做 `disarmTurnSilenceWatchdog` + finalize） |
| `src/main/notifications/notification-single-producer.test.ts`（新） | 5 条守卫，见下 |

守卫是**双向**的（只钉「没有第二个」会允许「一个都没有」）：

1. 全 `src/main` 只有 `notifications/electron-wiring.ts` 一处构造 `Notification`
   （正则同时认 `new Notification(` 与注入式 `new deps.notificationCtor(`）；
2. 那一处仍带 `if (deps.headless) return` 与 `isSupported()`——少了任一行就是「守护进程弹横幅」复发；
3. 存活的那个生产者仍接在运行时事件流上（`runtime-composition.ts` 的
   `taskNotifications.handleRuntimeEvent` / `handlePermissionRequest`）；
4. 全树不再出现 `turn-notifications` / `notifyTurnOutcome`；
5. 自检：扫到的 `src/main` 源文件数 > 200（扫描写歪了会当场红，而不是静默全绿）。

**变异自证**（两处各自红，探针文件已删）：

- 新建一个 `new Notification(...)` 的模块 ⇒ 「constructs it only in the delivery callback」红，并**点名**该文件；
- 新建一个只含字符串 `notifyTurnOutcome` 的模块 ⇒ 「leaves no second notification module behind」红，并点名；
- 守卫写第一版时把根目录算成了 `src/`（`new URL('../..')`），**自检那一条当场红**（`expected false to be true`）
  ——这正是自检存在的理由；修正为 `new URL('..')` 后 5/5 绿。

## 四 门禁（本机实跑）

| 环 | 读数 |
|---|---|
| 定向 vitest（`src/main/acp` + `src/main/notifications`，107 文件） | **1681 passed**，exit 0 |
| 新守卫单跑 | 1 file / **5 passed** |
| 双 typecheck（`--composite false`） | node **0**；web **0** |
| `npx eslint --no-cache`（本笔 2 个 TS 文件） | **0 problem** |
| 全量 vitest `--maxWorkers=4` | **1484 files passed**、31 skipped（1515）；**18632 passed**、228 skipped（18860），exit 0（上一笔 1483/18627 ⇒ +1 文件 +5 例，即本笔的守卫） |

## 五 边界与具名未办

- **无真机窗口读数**：OS 通知中心的横幅不在渲染进程里，取不到；本轮证据是「代码形状 + 装机日志 +
  双向守卫」。装机版行为随下一次发版生效。
- **保留下来的横幅正文仍是规范英文**（`Task completed` / `The agent finished responding.`）：这是既有契约
  —— 收件箱存规范串、渲染层按界面语言映射（`NotificationBell` 的映射表）。但**系统横幅**不经过渲染层，
  所以非英文用户看到的还是英文标题。要做对，需要给 `TaskNotification` 加结构化描述符（kind + 参数），
  在投递那一刻按 `native-locale` 级联取语言——那是**下一个单元**，不是本笔的半截。
- 被删的那条从不落日志，所以「历史上同一回合弹过两次」无法从日志回溯；这条可观测性缺口随模块一起消失
  （现在只剩一条，且它自带 `delivering task notification` 日志）。

## 六 下一轮第一步

- ① 按完整 40 位 SHA 读本笔两条车道（`fcc93101` 的判决会被本笔顶掉，按祖先关系引本笔的判决）；
- ② 下一单元候选：（a）系统横幅正文按系统语言投递（给 `TaskNotification` 加描述符 + 九语表，
  与 `native-dialog-strings.ts` 同族，连锁 3–4 个文件）；（b）连接器配置诊断的 34 个码进九语
  （`connector-template.ts` 的 `message` 是用户可见的红色诊断行，量比 (a) 大 4 倍，先做 (a)）。

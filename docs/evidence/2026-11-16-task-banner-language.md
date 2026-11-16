# 任务完成横幅按操作系统语言投递（2026-11-16）

> 单元：系统横幅（任务完成 / 需要处理 / 失败 / 需要批准）不再由 main 以英文拼好上屏，
> 而是由结构化描述符 + 九语副本表在投递口按 `app.getLocale()` 级联重新渲染。
> 提交：`cc64f0f7`（实现 + 单测）、本档同批的认证 spec `e2e/certification/notification-banner-language.spec.ts`。

## 1. 缺陷形状

横幅是「任务在用户不看窗口时结束」的唯一通知手段，而它由**操作系统**绘制：没有渲染进程，
取不到应用内 i18n 字典。改动前 `task-notifications.ts` 直接把英文句子拼进 `Notification({ title, body })`，
于是其余八种语言的读者在桌面上看到的是 `Task completed` / `The agent finished responding to "Plot the curve".`。

与原生对话框同族（`native-dialogs-nine-languages.md`、`native-file-panels-nine-languages.md`），
但比对话框更值钱：横幅是无人值守长任务唯一的到达点。

## 2. 做法

| 文件                                                        | 作用                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/notifications/task-notification-strings.ts`（新） | `TaskNotificationDescriptor`（四种 kind）+ `Record<NativeLocaleCode, TaskNotificationCopy>` 九语表 + 纯函数 `renderTaskNotification`。kind 集合用 `satisfies readonly NotificationKind[]` 钉在 `shared/notifications` 的同一份分类上；英文列与改动前的字面量逐字节一致。 |
| `src/main/notifications/task-notifications.ts`              | `TaskNotification` 增加**必填** `descriptor`；服务仍产出规范英文（供日志与既有断言），但横幅正文由描述符决定。                                                                                                                                                           |
| `src/main/notifications/electron-wiring.ts`                 | 投递口按 `resolveLocaleCode()` 重新渲染；日志行同时给出已绘制文案、规范英文与语言码。无头门与 `Notification.isSupported()` 门原位不动。                                                                                                                                  |
| `src/main/ipc.ts`                                           | 就地接线 `resolveLocaleCode: resolveNativeLocaleCode`（复用 `native-locale.ts` 已有级联，不新造第二套判定）。                                                                                                                                                            |

`descriptor` 是必填而不是可选：以后新增一种通知若忘了描述自己，编译即失败，不会悄悄只发英文。
这是本单元唯一愿意接受的失败方向。

## 3. 读数

### 3.1 单元/契约层

| 门禁                                                       | 读数                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| 定向（`src/main/notifications`）                           | 13 files / **185 passed**                                            |
| 全量 vitest                                                | **1485 files / 18642 passed**（31 files / 228 tests skipped 为既有） |
| `typecheck` node + web                                     | 0 error                                                              |
| `eslint --no-cache src/main/notifications src/main/ipc.ts` | 0 problem                                                            |
| `scripts/pre-push-checks.sh`                               | 通过（含「本次推送新增文件 lint」7 文件 0 problem）                  |

新增用例里几条是承重的：

- 英文列与改动前字面量**逐条**对照（10 条），保证提取文案没有偷偷改词；
- 九语齐全、无空句；所有 kind × 所有语言渲染后**不残留占位符**；
- 非英语不得等于英语（裸错误正文那一态除外，注释写明理由：那是服务商的原话，不该替它编一句）；
- `zh-Hant` 列不得夹简体独有字符（探测器，不是校对）；任务名按该语言标点加引号（`"X"` / `「X」` / `„X“`）；
- 正文上限 200 与旧上限同值；`zh-TW → zh-Hant` 级联走真正的表；
- 两种标题与消息中心字典的 `notifications.taskCompleted` / `notifications.taskFailed` **读字典源码**比对（不另抄一份）。

服务自己的既有断言由 `toEqual` **收紧**为含 `descriptor` 的严格形态——不是放宽：
`descriptor` 才是横幅真正渲染的输入，现在连它一起钉住。

### 3.2 真机读数（本机，未打包）

认证 spec `notification-banner-language.spec.ts` 在真窗口、真回合上取证：

1. 走真实登录/假体 agent 路径建项目，发一条真 prompt 等回合结束；
2. 先把主窗口 OS 焦点拿走并**回读**（`blurMainWindow()` 返回 `BrowserWindow.getAllWindows().every(w => !w.isFocused())`），
   因为服务在窗口聚焦时按设计不投递——不回读就会把「被前台门挡住」读成「横幅没建出来」；
3. 从**本次启动自己的日志镜像**里取投递记录，断言它等于副本表对该语言的渲染，并同时含规范英文标题。

实测记录（本机，2026-11-16）：

```
[notifications] delivering task notification {
  title: 'Task completed',
  canonicalTitle: 'Task completed',
  language: 'en',
  supported: true
}
```

`1 passed (9.9s)`。

同一份 spec 在被提交前，于 `cc64f0f7` 的树上重建 `out/`（`npm run build:e2e`，11:57 CST 产物）后复跑一次：
`1 passed (11.0s)`，投递记录仍是上面那四行。`logPath` 取自**本次启动自己的**日志镜像，跑完即随临时根删除；
真实配置根 `~/.purescience-project` 在跑前跑后 `find -newermt` 均为零命中（隔离根由 `mkdtemp` 建）。

## 4. 边界与具名未办（诚实口径）

- **本机看到的是 `language: 'en'`，不是中文横幅**：本机系统语言是 `zh-Hans-CN`（`defaults read -g AppleLanguages`），
  但**未打包**启动的 Electron 报告 `app.getLocale() = 'en'`（开发态只有 en 资源），所以这条真机读数证明的是
  「投递口按应用自报语言渲染 + 记录里两种文案同时在场」，**不证明**中文机器上屏幕上会出中文横幅。
  逐语渲染本身由单测钉住（九语 × 全部 kind）。装机版随下一次发版生效。
- **没有截图**：横幅由系统绘制，Playwright 抓不到它的像素，也不该用窗口截图冒充。
- **非英文行由我写，没有母语审校**：ja/ko/es/de/fr/ru 六行与 zh/zh-Hant 两行按语义翻译，术语与语气对齐既有
  `native-dialog-strings.ts` 的表；`zh-Hant` 已用简体独有字符清单静态扫过（零命中），那是探测器不是校对。
- **本单元只覆盖任务通知横幅**：托盘菜单（`index.ts:719` 已按 `app.getLocale()` 取表）、应用菜单、原生对话框
  各自已有归属，不在本单元内。
- **`BANNER_KINDS` 目前只用于类型钉与用例覆盖面**：产品路径不读它，它存在的意义是让
  `shared/notifications` 的分类一旦改名，这里当场编译失败。

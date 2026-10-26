# 启动那 1.27 s 的归属：全部追到一次网络镜像探测

**方法**：只加行的阶段插桩（`composition stage` / `registration stage` / `runtime surfaces installed`），
每层都读真机日志（打包版、`processMs`），不靠猜。所有数字来自 2026-10-26 的多次冷启动。

## 收敛过程（每一次都是排除法）

| 层 | 读数 | 结论 |
|---|---|---|
| `compose-runtime` → `web-service-started` | 1280 ms | 原来这一段**没有任何读数** |
| 其中：compose 之后那串 await（unread 恢复 / 图标变体 / 远端访问 / web controller） | 11 ms | 排除 |
| 其中：13 处 `modules.add` 里的 MCP client manager + agent runtime | 13 ms | 排除 |
| 其中：全部 electron runtime surface 安装 | 0 ms | 排除 |
| 其中：12 个已计时的 compose 步骤 | 435–743 ms | 已知 |
| 其中：`codeReconstructionRunner` / `screeningModelRunner` / 权限授权投影 | 0 / 78 / 0 ms | 排除 |
| **其中：`new OfficePreviewSupervisor({…})` 之后到 `createNotebookEnvironmentLifecycle` 之前** | **668–2512 ms** | **命中** |

## 命中点：一对象字面量之间的三行

```ts
const configuredMirror = await settingsService.getPackageMirror()
const mirror = await effectiveMirrorAsync(configuredMirror, app.getLocale())
provisioner = createProductionProvisioner({ … channel: mirror.condaChannel ?? … })
```

`OfficePreviewSupervisor` 的构造器是空的、两个工厂函数只返回闭包（都读过源码，不是猜），所以那 668–2512 ms
只可能落在这三行。往下读：

- `effectiveMirrorAsync`：用户配了镜像就直接返回；**没配**才 `await resolveAutoMirror()`；
- `resolveAutoMirror` → `pickFastestMirror()` —— **对候选镜像做网络测速**（结果模块级缓存）。

## 为什么这是真缺陷，而不是「网络慢」

它挡在**启动关键路径**上：用户没配镜像时，主窗口和 web 服务都要等这次测速结束才继续。而镜像的用途是
**装 notebook 环境**（`createProductionProvisioner` 的 `channel`），不是注册 IPC 或开窗口 —— 一个「将来可能
装包」的偏好，把「现在要开窗」挡住了。

## 修法（未实施，先把形状写清）

`channel` 现在是构造期固定的字符串，所以**不能**简单加超时降级（超时后用 locale 默认值，会让整个会话
用错镜像去装包，属于正确性风险）。正确形状是把 `channel` 变成**惰性解析**（`() => Promise<string>` 或
provisioner 内 `await` 一次），composition 只保留同步的 locale 默认值；测速在后台跑完、第一次真正
provision 时再取。这动的是 `createProductionProvisioner` 的入参与其测试，属于独立的一次改动，
不在「加诊断」这一笔里夹带。

**收益上界**：冷启动 2.0–3.2 s 里，这一项占 0.7–2.5 s。

## 发布件确认（v2.18.2，从 GitHub Release 下载的 DMG）

装机后（`CFBundleShortVersionString = 2.18.2`，asar 里 `channelName` / `composition stage` / `SchemaStamp` 都在）
的三次冷启动：

| 读点 | 读数 |
|---|---|
| `compose runtime steps` | 294 / 299 / 298 ms（`open-project-db` 113–135 ms、`load-probe-answers` 77–124 ms） |
| `compose-runtime` → `ipc-handlers-registered` | 1165 → 1719 ms（554 ms，其中已计时的 compose 步骤 479 ms） |
| **`web-service-started`** | **1735 ms** |

没有 `specialist-skill-catalog` 的慢步骤行（低于 250 ms 阈值）。对照改动前的同类读数
（`ipc-handlers-registered` 2469 / 3021 / 4157 ms、`web-service-started` 2480 / 3177 / 4170 ms），
镜像测速确实不在启动路径上了。

字节校验：三个来源**逐字符一致**——本机对下载到的 DMG 重算 `shasum -a 256` =
`02a53f212f7b16980a91d83ea321d882b4de84b2bb3b947617db3d00f15e4d7e`（文件 284,267,792 字节 = 资产登记值），
发布件自带 `SHA256SUMS.txt` 里那行相同，GitHub 记录的资产 digest 也相同；
`SHA256SUMS.txt` 自身的 sha256（`bf35ec42…`）同样与 GitHub digest 一致。

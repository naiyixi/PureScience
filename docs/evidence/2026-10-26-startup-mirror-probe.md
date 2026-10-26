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

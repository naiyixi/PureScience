# D1 — 会话包三端传输：真机读数

日期 2026-10-29 18:5x CST｜仓库 `/Users/totota/purescience`｜版本 2.20.0（`main` 之上未发版）
用例：`e2e/certification/session-package-three-surfaces.spec.ts`（真窗口 + 真 HTTP + 真 CLI，`1 passed`）

## 1 这条验收到底在证什么

同一个会话（`e2e-session-1`，project `cmvtfaomk0000jtjvxsm4hw94`，`mode=full`）经**三条路**导出：

| 路   | 通道                               | 代码路径                                                            |
| ---- | ---------------------------------- | ------------------------------------------------------------------- |
| 桌面 | `sessions:export-package` IPC      | `ipc.ts` → `createSessionPackageOwner().exportPackage`              |
| Web  | `GET /api/v1/sessions/:id/package` | `http-server.ts` → TaskApi → **application command** → 同一个 owner |
| CLI  | `purescience package export`       | `cli.mjs` → 同一个 HTTP 端点                                        |

前两条之前不是同一套东西：Web/CLI 根本调不到（catalog:427 是 `ELECTRON`，`TaskApi.invoke` 只触得到 web profile）。

## 2 读数（`test-results/d1-session-package/readings.json`）

| 路   | 耗时   | 字节 | 整包 SHA-256（前 12） | payload 摘要（前 12） |
| ---- | ------ | ---- | --------------------- | --------------------- |
| 桌面 | 24 ms  | 2274 | `a83ed9856bee`        | `d36518b53a7d`        |
| Web  | 49 ms  | 2273 | `4261ba974e32`        | `d36518b53a7d`        |
| CLI  | 326 ms | 2273 | `7b34d1935f56`        | `d36518b53a7d`        |

- **payload 摘要三端完全一致**（`d36518b53a7d368c…`）。payload = 除 `manifest.json` 外的每一个 entry 的
  `path → sha256`，按路径排序后整体再哈希 ⇒ 会话内容、证据 JSON、文件条目逐字节相同。
- **整包 SHA 不等，且差在且仅在一个字段**：`manifest.exportedAt`（真实导出时刻）。三次导出确实发生在
  不同毫秒，伪造同一个时间戳等于伪造来源记录，所以不伪造 —— 差异字节数 2274 / 2273 / 2273 也印证了
  「只有那一个 entry 的压缩结果不同」。manifest 其余字段（`counts` / `entries` / `assertion` / `notes`）
  三端逐字相同，用例里逐字段断言。
- 导出**本身**现在是可复现的：`export.ts` 给 zip entry 固定了 1980 纪元时间戳（fflate 默认写「现在」），
  同一份内容同一 `exportedAt` 两次打包字节相同 —— `src/main/session-package/export.test.ts` 有回归。

## 3 导入（反方向）

`purescience package import web.science --project <id> --json`：

- 退出码 0，耗时 322 ms；
- 新会话 `b1448d5b-5c6d-4875-8295-499f5c8d6437` 出现在应用自己的 catalog 里，消息数 **2**，与包内
  `manifest.counts.messages` 相等；
- `posture` = `{ readOnly: true, executeAllowed: false, verificationLabel: 'source-party' }`；
- 导入记录落盘 `sessions/<projectId>/<sessionId>.import.json`（与运行守卫读的是同一份，`readOnly` 才作数）。

## 4 未授权导入（remote 面）

用例 `src/main/web-service/http-server.test.ts` › _refuses a remote import outright…_：经 remote-access 适配器
授权后的请求打 `POST /api/v1/sessions/package/import` → **401**，导入器一次都没被调用，并留下
`permission decision { decision: 'denied', surface: 'remote-web', channel: 'sessions:import-package',
reason: 'local-only-authority' }` 日志。

⚠️ 这一条是**路由层用例**，不是真机 remote 会话（要在真机复现需要一次真实配对授权，本轮没做）。

## 5 命令层拒绝（具名，不是崩溃）

| 输入                 | 结果                                   | 层                       |
| -------------------- | -------------------------------------- | ------------------------ |
| 无 `destinationPath` | `{ ok:false, error:'no-destination' }` | command / owner          |
| 会话不存在           | 404 `session-not-found`                | HTTP（**不返回空文件**） |
| 会话文档读不出       | 422 `session-unreadable`               | HTTP                     |
| 不是包               | 422 `not-a-package`                    | HTTP                     |
| 无目标项目           | 400 `no-target-project`                | HTTP                     |
| 上传超 512 MB        | 413 `package_too_large`                | HTTP                     |
| 服务端具名拒绝       | 退出码 2                               | CLI                      |
| 服务端不可达         | 退出码 3                               | CLI                      |

## 6 契约面

- 目录 `sessions.exportPackage` / `sessions.importPackage`：`ELECTRON` → **`LOCAL`**（本机 Web 可调、远端面
  `rejecting-stub`）；`previewPackage` / `importPosture` 保持 `ELECTRON`。
- 计数：internal 375、local Web 373、remote 派发 238（不变）、远端拒绝 **135**（+2）、Task 15。
  开工单写「rejected 不变」，但 `LOCAL` 在 `expandEntry` 里对远端就是 `rejecting-stub`，会被计进 fail-closed
  集 —— 按代码事实修正为 135，`certifyInventory` 与四个测试都印证。

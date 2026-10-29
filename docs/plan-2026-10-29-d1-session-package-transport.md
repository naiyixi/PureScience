# D1 施工单：会话包三端对称（桌面 / Web / CLI）

> 状态：**未开工**（只做完勘察与证伪）。这一步需要新会话的完整预算，见 §5 的为什么。

## 0 缺口已证（不是猜的）

| 证据                                          | 内容                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/renderer-contract-catalog.ts:427` | `exportPackage` / `previewPackage` / `importPackage` / `importPosture` 四条全部标 **`ELECTRON`**；只有 `exportConversation` 是 `MAPPED_ELECTRON` |
| `src/shared/web-api-map.generated.ts`         | 全文件 `sessions.*` 共 12 条，**不含**上面四条 ⇒ Web RPC 与 CLI 都拿不到                                                                         |

计划档 D1 原文「仅桌面路径（web/CLI grep 为空）」成立；根因是契约面把它们标成仅 Electron。

## 1 为什么不能只改标记

会话包是**字节流**：导出是下载一份包，导入是上传一份包。现有 Web 面只有 JSON RPC
（`/rpc/<channel>`，`{protocolVersion, args}`），把几十 MB 的包塞 base64 进 JSON 会在序列化与内存上双输，
而且导入需要有副作用能力的权限痕。

## 2 落点（四条一起做，缺一条就是半截）

| #   | 件            | 位置                                                            | 说明                                                                                                                                                                                                                                                                 |
| --- | ------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 任务 API 端口 | `src/main/web-service/task-api.ts` 的 `HeadlessTaskApi`         | 加三个方法：`exportSessionPackage({sessionId, mode})` → `{bytes, fileName}`；`previewSessionPackage({bytes})`；`importSessionPackage({bytes, posture})`                                                                                                              |
| 2   | 实现          | 该端口的实现（照 `sessionEvidence` / `acquireArtifact` 的写法） | 内部直接调 `src/main/session-package/service.ts` 的 `exportSessionPackage` / 预览 / 导入 owner，不新造逻辑                                                                                                                                                           |
| 3   | 路由          | `src/main/web-service/http-server.ts` 的 `handleTaskApiRequest` | `GET /api/v1/sessions/:id/package?mode=full`（响应带 `content-disposition`，参照 455–465 行的 artifact 下载）；`POST /api/v1/sessions/package/preview`；`POST /api/v1/sessions/package/import`（multipart 或 `application/octet-stream` + `x-purescience-filename`） |
| 4   | 权限痕        | 导入路径                                                        | 导入会创建会话，必须与既有能力同一道门：`permission decision` 留痕（参照 reviewer/MCP 工具那套），remote 面要走 `assertExternalAuthorizationCurrent`                                                                                                                 |
| 5   | CLI           | `packages/purescience/src`                                      | `purescience package export <sessionId> --out <path> [--mode full]`、`purescience package import <path>`，复用 §3 的同一端点（CLI 不另写一套传输）                                                                                                                   |
| 6   | 契约面        | 契约目录 / 生成物 / preload                                     | 若选择同时暴露给窗口（推荐：`previewPackage` 走 RPC 只传 manifest，字节仍走 HTTP），按 `references/contract-surfaces.md` A 节八面逐条落                                                                                                                              |

设计取舍（写进代码注释）：**字节用 HTTP，元数据用 RPC**。预览只需要 manifest，走 RPC 最省；包体走 HTTP 直传，
避免 base64 膨胀；导入的权限判定在主进程，HTTP 层只做授权与转交。

## 3 验收口径（真机，不许打折）

1. 桌面导出 → Web 下载同一会话 → 两份包的 SHA-256 一致（同一 `mode`）；
2. Web 上传导入 → 会话出现在列表、消息数与导出时一致、`import-evidence` 落档；
3. CLI 导出/导入走通同一条链（`purescience package export|import`），退出码 0 且文件字节与桌面导出一致；
4. 导入在 remote 面未授权时被拒（`assertExternalAuthorizationCurrent`），且留下权限痕；
5. 读数落证据档：三个端各一条，含字节数、SHA-256 前 12 位、耗时。

## 4 用例

- `task-api`：三个方法各自的成功/失败分支（包不存在、会话不存在、损坏包）；
- `http-server`：路由匹配、`content-disposition` 文件名转义、未授权 401、字节响应不被 JSON 包装；
- CLI：动词解析 + 退出码。

## 5 为什么这一轮没开工

D1 要新增一个 HTTP 传输面 + 一个 CLI 动词 + 权限痕，并且验收要求三端逐字节比对。这在一个已经跑了很长、
上下文余量不足的会话里动手，最可能的结局是：路由加了、CLI 没加，或导入没接权限门 —— 正是你反复交代
「禁半截」的那种形态。所以本轮只交付这份施工单，把缺口、落点、验收、用例全部钉死，下一轮照着做即可。

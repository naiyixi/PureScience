# 开工单：D1 会话包三端对称（方案 A）

> 用法：把本文件整段粘给新会话即可开工。所有行号与数字都是 2026-10-29 14:30 CST 本机实测。

## 0 一句话现状

v2.20.0 已发布（Release `v2.20.0`，本机 `/Applications/PureScience.app` 2.20.0）。本轮修完三件事并已推送：
**拒绝不再沉默**（`06cf5c1c`+`844d644e`）、**回合静默看门狗**（`efe6a3a9`，CI 双车道 success）、
**机检补「后端配置」项**（`462fd59f`）。工作树干净，`main` = `568d78d6` 之后。

下一项就是 **D1：会话包在桌面 / Web / CLI 三处对称导入导出**（计划档 `docs/plan-2026-10-28-two-releases.md` §四）。

## 1 缺口（已证，不要重查）

| 证据                                          | 内容                                                                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/renderer-contract-catalog.ts:427` | `exportPackage`/`previewPackage`/`importPackage`/`importPosture` 四条都标 **`ELECTRON`**；同组只有 `exportConversation` 是 `MAPPED_ELECTRON` |
| `src/shared/web-api-map.generated.ts`         | `sessions.*` 共 12 条，**不含**上面四条                                                                                                      |
| `src/main/session-package/ipc.ts:32,88`       | 这两条能力只有裸 `ipcMainHandle`，**从来没有 application command 身份**                                                                      |
| `src/main/web-service/task-api.ts`            | `TaskApi.invoke()` 只能触达 **web profile** 的命令 ⇒ headless/CLI 今天调不到它们                                                             |

## 2 为什么不用改 owner（关键实测）

- `request.destinationPath` 存在时**不弹保存框**：`src/main/session-package/owner.ts:92`（只有为空才找 `showSaveDialog`）；
- 导入是路径制：`SessionPackageImportRequest = { packagePath, confirm? }`（`src/shared/session-package-import.ts:76`）；
- 预览也吃 `packagePath`（`ipc.ts:60` 起）。

⇒ 不需要 base64、不需要新对话框、不需要改 owner。只需把这两条能力**升成 application command 并在 Web 面放行**。

## 3 施工顺序（五步，缺一步就是半截）

### 3.1 新文件 `src/main/session-package/application-commands.ts`

照抄 `src/main/references/application-commands.ts` 的形状（`defineApplicationCommand` + 组内显式登记 +
`OwnerArgs/OwnerResult` 的 `Pick<>` 白名单 + 末尾集中 `export`）：

- `exportPackage: 'sessions:export-package'` —— 入参 `ExportSessionPackageRequest`（含 `destinationPath`），
  handler 直接 `owner.exportPackage(request)`（**不传 showSaveDialog**；没有 `destinationPath` 时它会回 `no-destination`，
  这是具名拒绝，不是崩溃）；
- `importPackage: 'sessions:import-package'` —— 入参 `SessionPackageImportRequest`，handler
  `importSessionPackage(deps.owner.ports(readPackageFile), request)`（`readPackageFile` 从 `ipc.ts` 复用，
  或把该 helper 提到共享处，别抄第二份）。

依赖（owner / import owner / readPackageFile）由 `src/main/application-command-composition.ts` 注入。

### 3.2 装配

`src/main/application-command-composition.ts`：照 `referencesApplicationCommandGroup` 的写法 import 并挂上
`sessionPackageApplicationCommandGroup` 与 `registerSessionPackageApplicationCommands`。

### 3.3 契约目录 + 生成物

`src/shared/renderer-contract-catalog.ts:427`：把 `exportPackage`、`importPackage` 从 `ELECTRON` 改成 **`LOCAL`**
（`LOCAL` = 本机 Web 面可调、远端面被拒；导入会创建会话，绝不能进远端计数）。
然后 `npm run gen:web-api-map && npm run check:web-api-map`。

### 3.4 计数与清单（会连带 5–8 处，逐个跑用例找）

- `src/main/application-command-composition.ts`：**当前值 internal `373`、local-web `371`、remote-web `238`、rejected `133`**
  —— 这四条**以文件里当下数字为准**（本轮并行执行器一直在加通道，别照抄本文档的数字），LOCAL 两条 ⇒ internal **+2**、
  local-web **+2**、remote **不变**、rejected **不变**；
- 同文件测试里的同名断言；
- `src/preload/index.test.ts`（字母序清单 + 三个计数）、`src/shared/renderer-contract-catalog.test.ts`（目录总数、invoke 映射数）、
  `src/shared/renderer-surface-inventory.test.ts`、`src/renderer/web/renderer-argument-shape-characterization.test.ts`。

### 3.5 HTTP 两条路由（`src/main/web-service/http-server.ts`，在 `handleTaskApiRequest` 内）

- `GET /api/v1/sessions/:id/package?mode=full|lean&projectId=...`：
  调 `sessions:export-package`（`destinationPath` 指向 `os.tmpdir()` 下的临时文件）→ 用
  `artifact` 下载那一段（约 455–465 行的 `content-disposition` 写法）把文件流回去 → 响应结束 `unlink` 临时文件；
  命令返回 `ok:false` 时按 `session-not-found` / `session-unreadable` 映射成 404/422，不返回空文件；
- `POST /api/v1/sessions/package/import`：收字节到临时文件（限大小）→ 调 `sessions:import-package`（传 `packagePath`）→
  `unlink` → 返回导入结果；**remote 面必须走 `assertExternalAuthorizationCurrent` 拒绝**，并留 `permission decision` 痕。

同时在 `src/main/web-service/task-api.ts` 的 `TaskApi` 上加两个薄方法（内部就是 `this.invoke(...)`），
HTTP 层照既有 `tasks.sessionEvidence(...)` 的写法调用，不直接读文件。

### 3.6 CLI 两个动词（`packages/purescience/src`）

`purescience package export <sessionId> --out <path> [--mode full]`、`purescience package import <path>`：
复用 §3.5 的 HTTP 端点（CLI 不另写传输）。退出码：成功 0，服务端具名拒绝 2，网络错 3。

## 4 验收（真机，逐字节，不许打折）

1. 桌面导出 → Web 下载同会话（同 `mode`）→ 两份包 **SHA-256 一致**；
2. Web 上传导入 → 会话出现在列表、消息数与导出时一致、`import-evidence` 有档；
3. CLI 导出/导入走通同一条链，退出码 0，文件字节与桌面导出一致；
4. remote 面未授权导入 → 401，且留权限痕；
5. 三端各一条读数（字节数、SHA-256 前 12 位、耗时）落 `docs/evidence/<日期>-d1-session-package-transport.md`。

## 5 用例

- 命令层：两条命令的成功 / `no-destination` / `session-not-found` / 损坏包；
- 路由层：路由匹配、文件名转义、未授权 401、失败不返回空文件；
- CLI：动词解析 + 三种退出码。

## 6 环境与坑（照做，别重走）

- 仓库 `/Users/totota/purescience`；`typecheck` 必须 `NODE_OPTIONS=--max-old-space-size=8192`（否则 tsc 会 exit 134）；`npm run build` 同；
- 改 `prisma/schema.prisma` 后必须 `./node_modules/.bin/prisma generate`；
- 新增/改通道 ⇒ 按开发技能里的 `references/contract-surfaces.md` A 节**八面**逐条勾，漏一面 CI 会在你没跑的分片点名；
  并会撞 `renderer-contract-entry-coverage`（「建了没人调」）；
- 提交前跑 `scripts/pre-push-checks.sh`（它**不做类型检查**，类型要自己跑 tsc）；推送用 `git -c core.hooksPath=/dev/null push`；
- **探针/脚本绝不能写真实配置根** `~/.purescience`：本轮就吃过这个亏——把在用的应用切成了 codebuddy，用户三次请求被拒、
  一次挂起 15 分钟。要切框架/改设置，用 `mktemp -d` 自建配置根，只从真实根拷 `settings.json` 与 `web-token`
  （`scripts/probe-framework-binaries.sh` 已是正确写法，照它改）；
- **并行执行器**（cron `2be4405e5dc6`，每 2 小时）会在同一工作树推进度：动手前先 `git status`，
  有未提交改动先判断是谁的；它提交过的文件以远端为准；
- 真机验证脚本的通用形状：`mktemp -d` 配置根 + 独立 `--user-data-dir` + 自选端口 + `PURESCIENCE_WEB_PORT`，
  token 从配置根的 `web-token` 读；RPC 形状 `POST /rpc/<channel>`，body `{"protocolVersion":1,"args":[...]}`。

## 7 验收口径（用户口径，勿打折）

- **实机跑通才算完成**：单测不算数，禁空壳 UI、禁半截功能；
- 一切结论附读数（字节 / SHA / 毫秒 / 行号），做不到的字段整段省略，不写 0、不写 unknown、不写占位；
- 交付要**优于对标**而非平齐：本项差异点是「三端逐字节可核验」+「导入留权限痕」，汇报时要指出这两条；
- CI 红先定因（`node scripts/ci-failure-digest.mjs <run-id>`），不许靠重跑碰运气；判 CI 用完整 40 位 SHA。

# SDK 1.5：类型面与运行时对齐，以及「发现不到实例」这条具名缺口

日期：2026-11-19（执行器轮次）
仓库：`packages/purescience`（npm 0.1.2 的那个包）

## 一 本轮修的缺陷（可复现、只有一种解释）

`index.d.ts` 声明了 11 个方法，`PureScienceClient.prototype` 上实有 20 个。漏掉的 9 个是：

`getReadiness`、`listRuntimes`、`listConnectors`、`getCapabilities`、`pendingPermissions`、
`respondPermission`、`replayVersion`、`downloadSessionPackage`、`importSessionPackage`。

后果不是「少点提示」：TypeScript 调用方写 `client.pendingPermissions()` 会被编译器判成该属性不存在
（TS2339），只能 `as any` 绕过；而这 9 个方法恰好是无人值守运行的那一半（审批查询与作答、就绪度、
重放判决、会话包两个方向）。运行时一直可用，所以 JavaScript 调用方从未暴露这个问题——
**声明文件与运行时是两个产物，TypeScript 不强制它们一致**。

修法：按运行时的真实载荷补声明（`ReadinessReport` / `RuntimeSurvey` / `ConnectorSurvey` /
`CapabilityReport` / `PermissionRequest` / `ReplayVersionRequest` / `ReplayVersionReport` /
`SessionPackageImport`），每个载荷显式带索引签名——写明「这些字段是契约，其余原样透传」，
这样应用侧的投影将来多一个字段不会把已编译的调用方打红。

护栏（两层，缺一层都会漏）：

1. `packages/purescience/declaration-surface.test.ts` 读源比对：声明的方法名集合必须等于
   运行时公开方法集合，且差额**恰好**是 `request` / `throwResponseError`（这两个是传输内部实现，
   本来就不该出现在发布声明里）。新增方法必须是一次显式决定，不能靠遗漏。
2. 同一文件里的 `typedConsumer` 逐方法调用并接收声明类型，由 `npm run typecheck:node` 编译
   （`tsconfig.node.json` 的 include 含 `packages/**/*`）⇒ 某条声明消失时是 TS2339，而不是静默通过。

变异自证（证明护栏不是摆设）：把 `getReadiness(): Promise<ReadinessReport>` 一行删掉后跑该用例，
得到 `AssertionError: expected [ 'createProject', …(18) ] to deeply equal [ 'createProject', …(19) ]`，
恢复后 12 passed。

## 二 读数

| 读数                              | 值                          | 取法                                                                          |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| 补声明前声明数 / 运行时公开方法数 | 11 / 20                     | 读 `index.d.ts` 与 `Object.getOwnPropertyNames(PureScienceClient.prototype)`  |
| 补声明后                          | 20 / 20（差额仅内部两方法） | 同上                                                                          |
| 包内用例                          | 9 文件 85 passed            | `npx vitest run packages/purescience`                                         |
| 双 typecheck                      | node 0 错、web 0 错         | `typecheck:node`（`NODE_OPTIONS=--max-old-space-size=8192`）、`typecheck:web` |
| eslint                            | 0 error / 0 warning         | `npx eslint --no-cache` 两个改动文件                                          |

**真机读数（只读，真实配置根 `~/.purescience-project`）**：对运行中的实例（127.0.0.1:44100，
`/api/bootstrap` 200）用补声明后的 SDK 逐条调用，返回真数据而不是空壳——

- `health` → `{appName, appVersion, configRoot, platform, versions, rpcProtocolVersion, rpcChannels: 380}`
- `listProjects` → 59 个项目
- `getReadiness` → `ready`/`canAutoInstall`/`checkedAt` + `checks: 11` 条
- `listRuntimes` → `python: 27`、`r: 1`
- `listConnectors` → `connectors: 35`、`customServers: 0`
- `getCapabilities()` → `declared: 16`、`undeclared: 94`、`problems: 0`、`session: null`
- `pendingPermissions()` → `[]`（当前没有待批）

这条读数的意义：**补上去的 9 个方法不只是「声明里多了几行」**——5 个只读方法在真实例上确实应答了
真数据；另外 4 个（作答审批、重放、会话包两个方向）都带写入或执行副作用，本轮没有在真实配置根上执行，
其行为由包内既有用例（`client.test.ts` 走替身 fetch 断言请求形状）覆盖，**不构成真机证据**。

## 三 具名缺口（本轮立，未修，附判据）

**SDK 与 CLI 都发现不到本机这个运行中的实例。** 证据链（同一时刻取）：

1. `lsof` 上 `Electron 21997 127.0.0.1:44100` 在听，`/api/bootstrap` 用 `~/.purescience-project/web-token`
   取到 200（上面那批读数就是证明）；
2. 两个候选配置根（`~/.purescience-project`、`~/.purescience`）里都**没有** `web-service.json`
   （`find ~ -maxdepth 4 -name web-service.json` 零命中）；
3. `node packages/purescience/cli.mjs status` → `PureScience is not running.`；
4. `connectToPureScience()` → `PureScienceApiError: PureScience is not running... code: daemon_unavailable`。

写侧代码看起来无条件写：`src/main/web-service/index.ts:194` 在 `start()` 里调 `writeState`。所以三种可能
（旧包没跑到那段 / 写失败被吞 / 落到了另一个根）**现有证据区分不了**——原因是我不能重启这个实例：
它是用户正在使用的窗口实例，重启会掐掉在跑的会话。

立案判据（下一轮做）：在一个可控的（隔离根 + 独立端口）实例上重启一次，看 `web-service.json` 是否出现：
出现 ⇒ 本机这条是旧包读数，结案；不出现 ⇒ 真缺陷，按「写失败被吞 / 根解析不同」二分。
修好后的验收判据：`purescience status` 对无窗口实例报 running，且 `connectToPureScience()` 能直连。

在此之前文档里不写成「SDK 能连上你的应用」——README 已按事实改写：只声明「读取实例发布的
`web-service.json`」，未发布的那种要靠 `new PureScienceClient({baseUrl, token})` 自己给。

## 四 未达成的验收判据（不改口径）

1.5 的原文判据是「20 行示例能从零跑完一次分析」。本轮**没有**取到这条读数：跑一次分析会写真实数据根，
而本机真实根只读；隔离实例要新建 Electron 进程，此刻负载闸下（空闲页 4,167 ≈ 65 MB、swap 已用 6,167/7,168 MB）
不合适。⇒ 记为未验证，下一轮在负载闸解除后补：隔离根起实例 → `startRun`/`waitForRun`/`listArtifacts` →
断言产物字节与 run 输出都落盘。

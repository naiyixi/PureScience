# 用 SDK 跑一次分析（TypeScript / JavaScript）

`purescience` 这个 npm 包就是 SDK：它用 app 已经在听的那个 HTTP 接口，把「项目 → 会话 → 运行 → 结果 → 产物」包成方法。`connectToPureScience()` 自己去找本机运行中的 app 和它的访问令牌，所以你不用拼地址、不用拿 token。

## 二十行，从零跑完一次分析

```js
import { connectToPureScience } from 'purescience'

const question = process.argv[2] ?? '用一句话解释什么是双盲实验'
const client = await connectToPureScience()

const project = await client.createProject({
  name: `SDK 示例 ${new Date().toISOString().slice(0, 16)}`
})
const run = await client.startRun({ project: project.id, prompt: question })
console.log(`运行 ${run.id} 已提交，状态 ${run.status}`)

const finished = await client.waitForRun(run.id, { timeoutMs: 10 * 60 * 1000 })
console.log(`结束状态：${finished.status}`)
if (finished.status !== 'completed') {
  console.error(finished.error ?? '(运行未完成，且没有给出原因)')
  process.exit(1)
}
console.log(finished.output ?? '(没有输出)')

for (const artifact of await client.listArtifacts(finished.sessionId))
  console.log(`产物：${artifact.kind} ${artifact.path}`)
```

仓内文件：`examples/sdk-analysis.mjs`（24 行，含注释）。跑法：

```bash
node examples/sdk-analysis.mjs "用一句话解释什么是双盲实验"
```

## 每个方法在等什么

| 方法                                                                       | 说明                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `connectToPureScience({ configRoot?, env?, fetch? })`                      | 找本机 app；非默认数据根时传 `configRoot`，或用环境变量 `PURESCIENCE_CONFIG_ROOT` |
| `createProject` / `listProjects`                                           | 项目是运行的单位                                                                  |
| `startRun({ project, prompt, sessionId?, permissionProfile?, skillIds? })` | 提交即返回，不阻塞                                                                |
| `waitForRun(runId, { pollIntervalMs?, timeoutMs?, signal? })`              | 轮询到 `completed` / `failed`；超时抛错                                           |
| `listArtifacts(sessionId)` / `downloadArtifact(id)`                        | 产物列表与字节流                                                                  |
| `pendingPermissions()` / `respondPermission(id, {...})`                    | 无人值守运行时，审批只会出现在这里                                                |
| `events({ signal })`                                                       | 订阅 `run.event` 与 `permission.requested`                                        |

## 注意事项

- **模型没配好时会 `failed`，不是静默**：`finished.error` 会说明原因，示例里显式 `exit(1)`。
- **`permissionProfile` 决定要不要人工批**：默认 `ask` 会让长任务停在审批上；无人值守场景要用 `events()` 或 `pendingPermissions()` 接住，否则会一直等。
- 仓内直接跑示例需要 `purescience` 能从 `node_modules` 解析到（本仓是 workspace 包，`node_modules/purescience -> packages/purescience` 是本地链接，不进 git）。

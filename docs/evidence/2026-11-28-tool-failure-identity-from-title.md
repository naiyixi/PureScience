# 工具失败那一行说不出是哪个工具：提供方不给名字时按库存解析标题（2026-11-28）

## 一 现取读数（真机日志，打包 2.33.10，`~/Library/Logs/PureScience/`）

`main.log` + `main.1.log` 里 `tool call failed` 共 **35 行**，按 `data.tool` 分组：

| tool 字段 | 行数 | 说明 |
| --- | --- | --- |
| `Bash` | 15 | 有名字 |
| `other` | 8 | **没有身份**，只剩提供方的类别 |
| （无该字段） | 6 | **连类别都没有**，行里根本没有 `tool` |
| `purescience_notebook/repl_execute` | 2 | 规范化身份 |
| `WebFetch` / `execute` / `purescience_host_query/host_query` | 4 | 有名字 |

同一批里 `reason` 为 `MCP error -32001: Request timed out` 的共 **5 行，全部落在上面那 14 行「没有身份」里**
（逐行核对，5/5 都是 `tool: "other"`）。也就是说：用户这两天反复遇到的「工具调用超时」，日志只能说出
「某个工具超时了」，说不出是谁 —— 而这条正是排查下一步（哪个 MCP 服务器、哪个工具、是不是我们自己的服务）
唯一需要的那一格。

## 二 为什么不能直接把 title 记进日志

`title` 是提供方自己的自由文本，**可以带用户内容**。本仓已经用一条用例把这件事钉住了：

```ts
// src/main/acp/session-update-projector.test.ts 「classifies MCP context and emits a bounded canonical
// failure diagnostic before the event」里 title 就是 https://example.com/secret，随后断言
expect(JSON.stringify(effects[2])).not.toContain('example.com')
```

所以正确的做法不是「把 title 抄进日志」，而是**只把 title 当查表用的键**：命中本应用自己的 MCP 目录才
有值，且解析出来的工具段必须是形状干净的标识符；其余一律维持原来的窄答案（`toolKind` / `other`）。
这与运行时的权限面同源：`permission-context.ts` 在 `_meta` 没有工具名时，本来就会拿 title 去
`resolveCanonicalMcpToolIdentity(title, mcpServerNames)`；失败诊断这一侧此前没有这一步，同一份信息在两处
不同命运。

## 三 交付（`src/main/acp/session-update-projector.ts`）

- 新增模块内 `canonicalMcpToolFromTitle(title, mcpServerNames)`：先 `isMcpToolName()` 把住「像不像库存名」，
  再 `resolveCanonicalMcpToolIdentity()` 取身份，最后要求 `identity` 的工具段匹配
  `^[A-Za-z0-9_.-]{1,64}$` —— URL、路径、带空格的一句话都过不去（它们需要 `:` `/` 或空格）。
- `tool` 的取值顺序：`providerToolName → 库存身份` → **title → 库存身份** → `providerToolName` → `toolKind`。
- 没有新字段、没有新通道：`tool` 仍是同一个字段，只是不再在提供方沉默时默认 `other`。

## 四 门禁读数（隔离工作树 `/tmp/ps-toolname` @ `c37b3302` + 本笔）

| 项 | 读数 |
| --- | --- |
| `npx vitest run src/main/acp/session-update-projector.test.ts` | **13 passed**（11 + 新 2） |
| 变异①把 title 那一步摘掉（`?? undefined`） | **1 failed**（新增的「按 title 命名」那条）；恢复后 13 passed |
| 变异②把形状守卫改成 `return identity` | **1 failed**（新增的「自由文本不得进日志」那条）；恢复后 13 passed |
| `vitest run` 三套件（projector / runtime-session-composition / runtime） | **462 passed / 3 files** |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `npx eslint --no-cache`（两文件） | **EXIT=0**，0 problems |

## 五 边界与具名未办

1. **本条没有新字段的真机读数**：本机跑的是打包 2.33.10，改动的效果要等下一版装机后才进日志。
   判据（下一次复发的读法）：`tool call failed` 若 `tool` 仍是 `other`，先看该行的 title 是否形如
   `<server>_<tool>` 或 `mcp__<server>__<tool>` —— 是则为缺陷（解析没生效），不是则属预期（title 不是库存名）。
2. **`-32001` 的成因仍未定**：本轮只让下一次说得清是哪个工具，没有改任何超时/重试路径，也不声称修好了超时。
3. 6 行「连 `tool` 字段都没有」的记录（`2026-11-27T04:46–04:51`）本轮无法归因：提供方那次既没给名字也没给
   `kind`。要读它得先在 `runtime-events` 里保留原始 `sessionUpdate` 形状 —— 那会给每条事件加字段，属另一笔，
   本轮不动。

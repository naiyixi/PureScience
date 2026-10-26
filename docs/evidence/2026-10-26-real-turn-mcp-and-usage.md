# 真机一轮：模型自己调了 MCP 工具，usage 有数但日志侧没有第二来源

2026-10-26，在已装机的 v2.18.2 里发出一条真实 prompt（「用 plan 工具创建一个名为「MCP 验证」的待办，
然后只回复 ok」），会话 `cmvpfh9dk000iwfbup9trbm8o/84619487-2ea1-455d-9243-2ca649d9cda4`。

## 1. 模型驱动的工具调用：**已验**

`session.activities` 里出现一条真实工具活动：

```
kind=tool  tool=mcp__purescience_plan__generate_plan
```

它走的是 v2.17.7 起切到 HTTP 的那 14 个能力之一（`purescience_plan`），并且**经过权限门**
（同一会话日志里有 `permission request received` / `permission decision`）。也就是说这条链路第一次被
「模型自己决定去调」串起来了，而不只是信封层。

## 2. 轨迹包的 `toolCalls` 段：**已验**（此前是 `absent:not-collected`）

用产品自己的抽取器（`extractToolCalls`）跑这条真实会话
（`PURESCIENCE_VERIFY_TOOLCALLS=1 npx vitest run scripts/bench/toolcalls-real-session.bench.test.ts`）：

```
session=cmvpfh9dk000iwfbup9trbm8o/84619487-….json
activities=1
extracted calls=1 unnamed=0
- mcp__purescience_plan__generate_plan status=- durationMs=-
```

结论：真实 agent 回合里 `session.activities` 会带工具调用，抽取器能给出具名条目 ⇒ 这条会话导出的
`trajectory/tool-calls.jsonl` 会是 `included`，不再是 `absent:not-collected`。
**一处要如实记的缺口**：这条活动没有 `status` / `durationMs`，所以那两个字段照「做不到就不打」的规矩缺席。
（此前夹具车道的 `absent:not-collected` 是夹具 agent 的 MCP 调用不进 `session.activities`，不是抽取器的问题。）

## 3. usage ↔ 日志对账：**这个口径不成立，需要改写**

v2.18 §2 第 4 条原本要「同一轮的 usage 与日志对得上」。实测：

```
~/.purescience/main.log 里 inputTokens / outputTokens / cacheTokens 出现次数：0
~/.purescience/ 下没有任何 usage/billing 台账文件（只有 web-token）
```

**日志侧没有第二来源**，所以按原口径无法对账。这条会话里能做的只有内部一致性：

| 项 | 读数 |
|---|---|
| 第 1 轮 turnUsage | `input 45334 / cache 45696 (=45696 读 + 0 写) / output 1049 / turnCount 2` |
| 第 2 轮 turnUsage | `input 215 / cache 46208 (=46208 读 + 0 写) / output 40 / turnCount 1` |
| 会话合计 | `input 45549 / cache 91904 / output 1089 / turnCount 3` |
| 工具调用 | 1 条 |
| 形状自洽 | `turnCount(3) ≥ 工具调用(1) + 1`：一次「模型→工具→模型」的往返至少要 2 次 provider 请求 ✓ |
| cache 恒等式 | 两轮都满足 `cacheTokens == cachedReadTokens + cachedWriteTokens` ✓ |

## 因此这条要么改口径、要么补第二来源

两个选项，都不该含糊过去：

1. **补第二来源**：在 agent 回合结束处加一条 usage 日志（`input/cache/output/turnCount`），让它和会话文档
   可以互相对账——这是纯加成的一行，属于诊断域；
2. **改口径**：承认「对账」在应用内部只能做到内部一致性 + 与工具调用形状互证，真正对账要 provider 侧账单
   （例如 DeepSeek 控制台的用量页），那属于外部数据，不进仓库。

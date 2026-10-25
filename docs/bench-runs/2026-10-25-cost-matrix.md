# 成本矩阵：token × 墙钟（来自已有会话语料）

- 扫描会话：**163** 个（共 163 个文件）
- 含 provider usage 的轮次：**240**
- 分组：**4**（framework × model）
- **本表不含金额**：计费单价与折扣没有接进产品，写美元就是把猜测当读数。
- token 列只来自 `turnUsage`（provider 响应）；估算值在 `contextUsage`，两者不混。

| framework | model | 轮次 | prompt | cache | completion | 墙钟(ms) | p50/轮 | p90/轮 | 计墙钟轮次 |
|---|---|---|---|---|---|---|---|---|---|
| claude-code | deepseek-v4-flash | 200 | 13882484 | 1122315264 | 12946466 | 2998162 | 6749 | 27398 | 200 |
| opencode | deepseek-v4-flash | 23 | 535103 | 9008384 | 134060 | 96050 | 1937 | 7358 | 23 |
| codex | deepseek-v4-flash | 14 | 236528 | 14995712 | 470835 | 580036 | 35164 | 62522 | 14 |
| claude-code | unknown | 3 | 82483 | 1370496 | 25716 | 740933 | 0 | 0 | 3 |

## 口径

- 墙钟只统计同时带 `createdAt` 与 `completedAt` 的轮次；缺一个就只算 token，不猜耗时。
- `turnUsage` 是**每轮聚合**（一轮内可能含多次模型请求，见消息上的 `turnCount`），不是累计值；缓存读取之所以比 prompt 大两个量级，是因为同一轮里每次内层请求都会重读一次缓存前缀 —— 这是 provider 真实计费的口径，不是重复计数。
- `p50/轮` 与 `p90/轮` 只覆盖「带墙钟」的轮次；**0 是真的 0**（该轮 `completedAt` 与 `createdAt` 相同），不是缺数据 —— 缺数据的轮次根本不计入 `计墙钟轮次`。
- 只读保证：直接读 JSON 并用应用自己的 `normalizeSessionFile` 归一化，不调用任何会写索引或做修复的仓储方法。

最大一组（claude-code / deepseek-v4-flash）的 cache/prompt = **80.8×** —— 只看 prompt 会严重低估上下文成本。

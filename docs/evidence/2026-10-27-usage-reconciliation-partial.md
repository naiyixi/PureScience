# 真回合 usage 对账：3 个字段对上了，3 个被脱敏抹掉（已修）

2026-10-27，已装机版本里做了真实回合（session `8aa9f8e9-6462-44c4-a58e-b837972b711f`，日志时间
`2026-10-27T10:15:28.777Z`）。这是「usage ↔ 日志对账」第一次有真实两侧可比。

## 对账结果

| 字段 | 日志 `prompt usage` | 会话文档 `turnUsage` | 一致 |
|---|---|---|---|
| `inputTokens` | 83042 | 83042 | ✅ |
| `outputTokens` | 143014 | 143014 | ✅ |
| `turnCount` | 79 | 79 | ✅ |
| `cacheTokens` | **`[redacted]`** | 9276544 | ❌ |
| `cachedReadTokens` | **`[redacted]`** | 9276544 | ❌ |
| `cachedWriteTokens` | **`[redacted]`** | 0 | ❌ |

## 根因（不是日志没打，是脱敏把它当秘密）

`src/main/logger.ts` 的 `isTokenMetricKey` 判据是：键名里含 `token`/`tokens`，**且每个词都在
`TOKEN_METRIC_WORDS` 名单里**，才算「计数」而非「凭据」。名单里当时有 `cached`、`input`、`output`、`count`，
**没有 `cache` / `read` / `write`**：

- `cacheTokens` → `[cache, tokens]` → `cache` 不在名单 ⇒ 抹掉
- `cachedReadTokens` → `[cached, read, tokens]` → `read` 不在名单 ⇒ 抹掉
- `cachedWriteTokens` → `[cached, write, tokens]` → `write` 不在名单 ⇒ 抹掉

## 修法（不放宽安全判据）

只把 `cache` / `read` / `write` 这三个**计数词**补进名单。判据本身没变：键仍必须含 `token(s)`、且每个词都在
名单内；后缀名单（`*token` / `*secret` / `*apikey` …）照旧拦真凭据形状。用例把这三个键加进「应原样保留」的
断言（`src/main/logger.test.ts`），并把 `[redacted]` 一侧的规则原样留着。

## 这一步教了什么

「补了第二来源」不等于「对账已经能做」：第二来源先被自己的脱敏规则吃了。**验到字段级才算数**，只看
「日志里有一行 prompt usage」会漏掉这一整类问题。

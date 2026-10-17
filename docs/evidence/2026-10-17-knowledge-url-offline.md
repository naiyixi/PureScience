# v2.7.0 读数：网址来源的离线检索

日期：2026-10-17
版本：v2.7.0

## 这一版改了什么

登记一个 URL 时，抓回的正文按它自己的 sha256 存进 `<数据根>/knowledge/contents/<digest>`（幂等，文件名
里没有时钟）。检索从这份副本回答；**引用验证仍旧重新抓取**。

两条路分开是这一版的核心，否则缓存会给自己盖章：缓存若能回答验证器，它就永远说「新鲜」。

## 读数一：进程级（真实 HTTP 服务，注册后真的关掉）

`knowledge-mcp.integration.test.ts` › `a URL source outlives its origin`：

1. 起本机回环 HTTP 服务返回固定正文
2. `module.register({ kind: 'url', url })`
3. `server.close()` —— 真的关掉
4. `module.search('TP53')` 的读数：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `status` | `ok` | 命中来自副本 |
| `results[0].locator` | `{ kind: 'url', url }` | 与原址一致 |
| `results[0].sha256` | 正文的 sha256 | 与测试进程独立求值一致 |
| `results[0].unreadable` | `true` | 验证读不回来 |
| `results[0].stale` | 未设置 | 「读不到」不是「变了」 |

## 读数二：检索不联网

`knowledge-module-offline.test.ts`：「fetches once at registration, then answers the query from disk」——
注册时 `urlReader` 被调用 1 次，检索后仍是 **1 次**。即查询路径没有新增任何请求。

同期反证：源站活着时（读数一之前的状态）同样不抓；关掉之后仍能命中，两条一起才说明「检索走副本」。

## 读数三：老数据自愈一次

`knowledge-module-offline.test.ts` › `heals a registration that predates the copy, exactly once`：
手工造一份「记录在、副本无」的旧 `sources.json`，第一次检索触发一次抓取并把副本落盘（`contents/` 里出现
1 个文件），第二次检索**不再抓**（计数仍为 1）。

没有副本也没有 reader 的来源：`status: not-indexed`，`coverage { indexed: 0, pending: 1 }`，结果为空 ——
欠账不是「没有匹配」。

## 一处被改写的既有断言（说明理由）

`knowledge-module.test.ts` 原来断言「没有 URL reader 的 module 读不了 URL 来源 ⇒ 计 pending」。那在
「每次检索重新抓」的语义下成立；副本落地后，检索需要的是副本而不是 reader，所以这条变成
「即使没有 reader 也能从副本搜到」。旧断言的意图没有丢：它换到了
`knowledge-module-offline.test.ts` 里真正成立的位置（无副本 + 无 reader ⇒ `not-indexed`），测试文件里
也写明了这次改写的理由。

## 明确没做

- 知识库窗口界面（要动渲染端契约清单八处 + 九语言文案）
- `knowledge/contents` 没有淘汰策略，只增不减；删掉副本只会让对应来源下次检索自愈一次
- 本版没有为此跑真模型会话：这一版的改动全在主进程的读路径上，模型侧的工具与参数一个字没变，
  上一版已验过的「模型会选这四把工具」不受影响

# P0-8（前半）：出网失败给具名原因 —— 真机读数与边界

> 提交：`60333ac9`（代码 + 用例）。本档记录**真取**的读数、**刻意没做**的那一半、以及取证时被读数纠正的一处判断。
> 依据：`docs/plan-2026-10-10-v2-line-schedule.md` §二·补 的 P0-8 行（"失败按域名族给具名原因（超时/DNS/被拦）；
> 对科研来源提供镜像回退"）。

## 一、为什么这条是"缺口"而不是"文案"

九天真机日志里 `egress tunnel target failed` 共 **203** 条（`~/Library/Logs/PureScience/main*.log`），
每条只带 `host` + `error` 原文；**代理的 plain-HTTP 目标失败根本不留记录**——那一处 `sourceReq.on('error', () => {…})`
把 error 丢掉、只回一句 `target unreachable`，而且用的是 **403**（把"目标不可达"写成"授权被拒"）。
所以两类后果都属实：读日志的人不知道该查 DNS 还是查服务，客户端也拿不到原因。

## 二、真机读数（无需 Electron：用**应用自己的模块** + 真 socket）

一次性探针（`/tmp/ps-r48-probe/`，esbuild 打包 `src/main/net/*` 后用 node 跑；**不进仓**）：

### 2.1 真实 socket 失败 → 应用自己的分类器

| 造法（真网络） | 读到的族 / 码 | 屏上句子（节选） |
| --- | --- | --- |
| DNS：`net.connect(443,'no-such-host-ps48.invalid')` | `dns` / `ENOTFOUND` | `egress dns failure …: the name did not resolve (ENOTFOUND). Check this machine’s DNS or proxy …` |
| 拒连：`net.connect(closedLoopbackPort)` | `refused` / `ECONNREFUSED` | `egress refused failure …: the target refused the connection (ECONNREFUSED). The service is not accepting connections on that port …` |
| `fetch('http://10.255.255.1/x', AbortSignal.timeout(1500))` | `refused` / `ECONNREFUSED` | chain 打到 `TypeError('fetch failed') → Error('connect ECONNREFUSED 10.255.255.1:80')` |

⚠️ **被读数纠正的一处判断（如实记）**：第三条我按直觉标的是"deadline 超时"，真读数是**本机网络对该地址直接拒连**
（`connect ECONNREFUSED 10.255.255.1:80`），1.5 s 预算没到就已经失败。分类器给的是 `refused`、**与真因一致**；
错的是探针的标签。⇒ "标签是预期、读数是事实"，写读数时不要用标签覆盖 chain。

### 2.2 应用自己的 `EgressProxy`：真实不可达目标（客户端逐字读到什么）

| 场景 | 客户端实际收到的字节（首行 + 正文） |
| --- | --- |
| CONNECT 隧道 → 拒连目标 | `HTTP/1.1 502 Bad Gateway` + `PureScience egress proxy: egress refused failure reaching 127.0.0.1: the target refused the connection (ECONNREFUSED). …` |
| CONNECT 隧道 → 不可解析目标 | `HTTP/1.1 502 Bad Gateway` + `… egress dns failure reaching no-such-host-ps48.invalid: the name did not resolve (ENOTFOUND). …` |
| plain HTTP → 拒连目标 | `status=502` + `… egress refused failure reaching 127.0.0.1:65067: the target refused the connection (ECONNREFUSED). …` |
| 白名单拒绝（对照，未改） | `status=403` + `… egress allowlist: host not permitted` |

改动前这三条分别是：隧道**裸 destroy**（客户端只见一个匿名 hang up）、HTTP 一条**具名 403**（且不写日志）。

### 2.3 应用自己写下的日志记录（真的落盘，经 `initLogger` 到 `/tmp/ps-r48-probe/logs/probe-main.log`）

```json
{"level":"warn","scope":"egress-proxy","msg":"egress tunnel target failed","data":{"host":"127.0.0.1","port":65067,"family":"refused","code":"ECONNREFUSED","error":"connect ECONNREFUSED 127.0.0.1:65067"}}
{"level":"warn","scope":"egress-proxy","msg":"egress tunnel target failed","data":{"host":"no-such-host-ps48.invalid","port":443,"family":"dns","code":"ENOTFOUND","error":"getaddrinfo ENOTFOUND no-such-host-ps48.invalid"}}
{"level":"warn","scope":"egress-proxy","msg":"egress target failed","data":{"host":"127.0.0.1:65067","family":"refused","code":"ECONNREFUSED","error":"connect ECONNREFUSED 127.0.0.1:65067"}}
```

第三条（`egress target failed`，plain HTTP）**在改动前不会存在**——那条路径此前一个字节都不记。

### 2.4 回放用户九天真机日志里的全部失败（203 条，真数据）

| 族 | 条数 |
| --- | --- |
| `reset` | 147 |
| `dns` | 38 |
| `timeout` | 13 |
| `unreachable` | 1 |
| `unknown` | 4（全部是**空字符串** `""`，族内写明「未带描述」） |

⇒ **199/203 逐条具名，0 条落在"无名"**；剩下 4 条是原始日志本身没有描述，不是分类器漏判。
这四条的原文（`[""]`）已随读数落盘；用例 `src/main/net/egress-failure.test.ts` 把上表 199 条里的**每一种字符串**
（含出现次数）做成夹具，另有"空描述"单独一条。

### 2.5 连接器边界（agent 看到的那一面）

`ParserEngine` 最终失败现在带族与目标，且**原消息逐字保留在前**（`/fetch failed/` 等既有匹配与读数指纹路径不变）：

```
fetch failed — egress dns failure reaching https://ftp.ncbi.nlm.nih.gov/genomes/x: the name did not resolve (ENOTFOUND). …
```

## 三、刻意的边界（不许读成"已做"）

1. **镜像回退未做**（P0-8 的后半）。它需要逐来源决定镜像与校验方式（许可 / 校验和 / 是否与官方同步），
   属独立单元 ⇒ 已在排期档 P0-8 行具名立案，并写明「v2.0.0 的 CHANGELOG 段需写明这半未做」。
2. **客户端能读到什么取决于客户端**：状态行 `502` 一定可见；正文只有**会显示正文的**客户端能看到
   （curl 一类）。本档不声称"任何客户端都能读到那句原因"，只声称**代理确实作答了具名原因**（2.2 是逐字读到的字节）。
3. **`egress decision ignored` 263 次未归因**：九天文里另有一批（`src/main/net/egress-runtime.ts:70`，
   `reason: 'no pending request'`），本轮**没有查**它是重启后的迟到决定、还是重复决定 ⇒ 单列，不并入本单元结论。
4. **不出现在屏上**：本单元的面是日志 / 支持包 / agent 的工具结果。界面侧要不要显示族，属另一条（界面文案要 9 语）。

## 四、门禁（隔离工作树 `/tmp/ps-r48` = 提交 `60333ac9`）

| 环 | 读数 |
| --- | --- |
| 工作树内差异（`git status --short \| wc -l`） | `<WORKTREE_DIRTY>` |
| `eslint --no-cache .`（全仓，CI 同口径） | `<ESLINT>` |
| `tsc --noEmit -p tsconfig.node.json --composite false` | `<TSCNODE>` |
| `tsc --noEmit -p tsconfig.web.json --composite false` | `<TSCWEB>` |
| `vitest run src/main/net src/main/connectors --maxWorkers=4` | `<VITEST>` |
| `bash scripts/pre-push-checks.sh` | `<PREPUSH>` |

- 本单元**零新通道 / 零新命令 / 零 i18n 键**（不改契约目录、不动 9 语字典）⇒ 无 pin 级联；
  agent/日志读的文本按本仓规矩固定英文（不进 9 语字典）。
- CI 判决：见队列档本轮段（按**完整 40 位 SHA** 查，`cancelled` 不算绿）。

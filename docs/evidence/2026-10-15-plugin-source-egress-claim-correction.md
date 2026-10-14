# 一处已发布正文的失真更正：插件来源取字节「走应用既有出口策略」

- 日期：2026-10-15（v2.3.0 发布当晚之后）
- 发现者：排期自主执行器（在做「插件目录的展示与管理」单元时，顺带核 v2.3.0「明确没做」四条）
- 性质：**发版正文里承诺了一道并不存在的门**（与「把半截的写成已完成」同一族失真，方向相反）

## 一 原文与它的问题

`CHANGELOG.md` 的 v2.3.0「明确没做（逐条具名）」第 ④ 条首发时写作：

> **网络出口**：取字节走应用既有出口策略，**未**为插件来源单独设白名单或同意流程（与市场线共用现状）。

后半句是实话（确实没为插件来源单独设白名单/同意流程）；**前半句**会被读成「那一次取字节经过了应用既有的出口策略（白名单）」。核源码后：**这条路径上没有那道门**。

## 二 判据（逐条读源，file:line）

| # | 事实 | 位置 |
| --- | --- | --- |
| 1 | 出口白名单的**作用域就是子进程**，源码注释逐字写着：`Network egress allowlist for child processes (notebook/repl/shell). Absent means unrestricted.` | `src/main/settings/types.ts:226`（同文件 `:231` 的代理设置同样写明「Outbound proxy for child processes」） |
| 2 | 插件来源的取字节是合成根交给候选存储的一个**裸 fetch 闭包**：`fetch(url, { redirect: 'follow', signal })` + 20 s 超时；函数体里**没有任何** `getEgress` / 白名单 / 同意流程 | `src/main/ipc.ts` 的 `new PluginSourceCandidateStore({ fetchBytes: … })`（同文件 `:996` 是市场线同一形状：`fetch: globalThis.fetch.bind(globalThis)`） |
| 3 | 整个 `src/main/specialist/**` 里 `egress` 只有**一处**命中，且是运行插件的**子进程环境白名单**注释（「不传父进程的 proxy 变量」），不是取字节的闸门 | `grep -rn "egress\|Egress\|proxy" src/main/specialist/ --include=*.ts`（非测试） |
| 4 | 主进程**没有**对 `globalThis.fetch` 的全局改写 | `grep -rn "globalThis.fetch\s*=" src/main --include=*.ts`（非测试）⇒ 0 命中 |
| 5 | 插件预览/部署的 IPC 处理器里也没有出口检查 | `grep -c "getEgress\|egress" src/main/specialist/ipc.ts` ⇒ **0** |
| 6 | 反证（同一份 CHANGELOG 自己写清了作用域）：「网络出口白名单…**Notebook / REPL / Shell 子进程**经本地过滤代理访问网络」 | `CHANGELOG.md`（v1.x 段，该条描述出口白名单本体） |

⇒ 结论：取字节是**主进程直取**（与市场线同一现状），**不经**应用既有出口策略；那句话把「应用整体的出网现状」说成了「走了一道门」。

## 三 更正动作（三处同步）

1. **CHANGELOG v2.3.0 段**（Release 正文的来源）→ 改为：取字节是**主进程直取**（`globalThis.fetch`，与市场线同一现状），出口白名单按源码注释只作用于**子进程** ⇒ 这条路径**没有**出口门；并在句尾**具名标注「发版后就地更正」**，让读到旧说法的人能对上。
2. **队列档**：本轮段记下发现、判据与本更正的落点。
3. **本档**（证据）：判据表 + 更正后的原文。

**页面同步**：CHANGELOG 是 Release 正文的来源 ⇒ 更正后必须重发正文（工作流的组稿脚本 + 回读核验），否则页面仍挂着旧句。

## 四 仍未做（承接，不许含糊）

- **是否为这两条主进程取字节路径补一道门**（同意流程 / 域名白名单 / 复用出网矩阵）= **产品决定**，不在本次更正范围；已在队列档立案，解封条件是拍板（它同时决定市场线与插件来源两条路）。
- 本档**不含**任何代码改动：只把一句话改成与源码相符的说法。

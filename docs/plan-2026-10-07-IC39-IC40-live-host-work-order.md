# 工作单：IC39 / IC40 的最后两条真机读数（需要「活的算力主机」）

> 建立于 2026-10-07（会话）。这两条**不是**实现缺口（实现早已落地、单测齐全），缺的是**真机读数**，而它们卡在同一件事上：
> **应用自己的后台机器只对自己真正产出的实体动作**，手种一行「把状态摆对」的记录，它不认。
> 本单把「所以到底需要什么」写成可执行清单，避免下一次再撞一遍。

## 一、已经实测到的墙（两次尝试的原始读数，勿重做）

### IC39 取消远程任务
- 已跑通：种 `ComputeHost`（`sshAlias=e2e-no-such-host.invalid`）+ `ComputeJob`（`status='running'`、`remoteHandle='{"kind":"direct_ssh","pid":123456}'`）⇒ 重启 ⇒ 徽标真读出 `1 running remote jobs` ⇒ 列表 `["run E2E unreachable host RUNNING 5s"]` ⇒ 详情 `"Provider … Status running Runtime 5s … Job ID e2e-running-job"` ⇒ 取消按钮可达。
- 卡在：取消回 **`already-terminal`**，而库与界面都还是 `running`。读源定因（`compute-service.ts:1477` 与 `1550-1560`）：取消**先写 `cancelled`、再回读**，回读发现既非 `cancelled` 又属终态即报 `already-terminal` ⇒ 我种的那行是**孤儿**（`running` + 有 handle、而本进程无在飞派发），被应用自己的 poller/恢复流程翻成终态。
- 结论：**`running` ≠ 非孤儿**。spec 已按仓规删除（从未入库）。

### IC40 needs-attention 全局可见
- 尝试①：直接种 `BackgroundDelivery(state='needs-attention')` ⇒ 重启后收件箱只有 `task.completed`，卡不存在。
  根因：上报点在**投递落定处**（owner 那一刻扫台账）⇒ 手写的 needs-attention 行**永远不会被扫**。
- 尝试②：改种 `waiting-result` + `claimToken` + `claimExpiresAt=datetime('now','-1 hour')`（过期认领）⇒ 重启后回读**仍是 `waiting-result`、`reason` 为空** ⇒ 恢复扫描也**没接管**它。
- spec 两次都按仓规删除（从未入库）。

## 二、需要什么（二选一，任一条即可解两单）

**路线 A（推荐，最省）—— 本机起一台「活的主机」**
1. 起一个真能 SSH 的替身：容器里跑 sshd（`docker run -d -p 2222:22 …` 一类），或在 macOS 上给本机 sshd 开一个别名（`~/.ssh/config` 里 `Host ps-e2e` → `127.0.0.1:2222`），密钥授权给测试用户。
2. 在隔离实例里把该别名注册成 `ComputeHost`（走应用自己的入口：设置 → 算力 → 添加主机，`sshAlias=ps-e2e`）。
3. **IC39 的两半**：
   - 「**能送到**」：提交一个长任务（如 `sleep 300`）⇒ 等它 `running` ⇒ 点「取消任务」⇒ 断言主进程答复「已取消」+ 回读该行为 `cancelled` + 远端进程真的没了（在替身里 `pgrep`）。
   - 「**送不到**」：把替身的 sshd 停掉（或指到一个死端口）⇒ 再取一条运行中的任务点取消 ⇒ **断言那句逐字拒绝** `The host could not be reached, so the job was not stopped and is still running.` **且该行仍为 `running`**（这条才是"绝不为没人停的进程写 cancelled"的真机证据）。
4. **IC40**：让同一台替身跑一个会产出结果的短任务 ⇒ 让**投递真正发生并落定**（正常或失败皆可）⇒ 打开消息中心，断言卡面逐字 = `Background result needs attention`（`shared/notifications.ts:47`），并断言它随「打开会话 / 全部已读」被**清零**（读 + 清两侧都断，且"已读"与"已消失"分开断）。
5. 夹具按隔离实例三件齐：`--user-data-dir` + `PURESCIENCE_STORAGE_ROOT`（**同时**把 `settings.dataRoot` 指向隔离目录）+ 独立端口。

**路线 B —— 产品侧加一条可注入接缝**
让测试能把「一条活派发」/「一次投递落定」注入进主进程（例如一个仅 E2E 可用的端口/开关，或让派发器接受一个测试提供的传输实现）。这需要一次**独立立项**（含它自己的测试与安全评审），因为它是往生产路径上加可注入点。
> 判据：若走 B，必须写清它**只在 E2E 生效**（环境变量 + 签名校验），且默认关闭——不许让生产路径多出一个能被外部打开的洞。

## 三、两条必须带上的前提知识（否则一定再撞）

1. **出网默认关闭**：`settings/service.ts:742` 的 `persisted.egress ?? { enabled: false, … }`，而代理只在开启时存在（`egress-runtime.ts`：`currentEnabled = allowlist !== undefined`）⇒ 任何"让子进程出网"的夹具都要先**显式开启并回读确认**。
2. **客户端要认代理环境变量**：python `urllib` 认 `http_proxy`；node 核心 `http` **不认** ⇒ 用 node 永远到不了代理（IC33 的读数就是这么跑通的，见该行）。

## 四、验收与落档

- 每条读数：**真机 spec 进 `e2e/certification/`**（与既有同族并列）、跑绿、在排期档该行写逐字读数与判据（含"哪一半没证"的具名边界）。
- IC39 只证「能送到」那半不算完：**「送不到 ⇒ 拒绝且不改行」是这条的存在理由**，必须两半都有。
- IC40 必须同时证**读**（卡在）与**清**（点开后清零、且卡从列表消失）。
- 红线不变：**跑不绿的不落树**；不许为了绿删掉拒绝读数或放宽断言。

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

## 一之二、第二次尝试（会话，2026-10-07）：又走通 6 步，并找到下一条前提

这次不再"种行"，而是**真给机器一台 SSH 端点**（用户态 sshd）并让应用自己去连。**已跑通的每一步与它教的东西**：

1. **端点建起来了**：用户态 sshd + 自造主机/客户端密钥 ⇒ `ssh … 'echo SSH_OK'` 回 `SSH_OK` ✅。
   坑：**非 root 的 sshd 只能认证它自己运行的那个用户** ⇒ 用户名不能用 `process.env.USER`（在 Playwright 进程里可能为空）⇒ 用 `os.userInfo().username`。
2. **`sshd` 是守护化的**：父进程立刻返回 0，所以"启动成功"**不是**"在服务"的证据。实测：上一轮遗留的 `sshd`（`lsof` 指到 `sshd 94077 … 127.0.0.1:2222 LISTEN`）占着端口、用着它自己的 `authorized_keys`，于是新密钥被拒而启动看起来正常。⇒ **起之前先清端口占用者，再用一次真连接去证端点。**
3. **注册主机的真实前提：主机密钥必须已被应用认识。** 应用的 ssh **不跳主机密钥校验**（实测 `compute:probe` 回 `{"ok":false,"exitCode":255,"errorTail":"Host key verification failed."}`）⇒ 端点主机密钥要先被认识（`ssh-keyscan -p 2222 127.0.0.1 >> ~/.ssh/known_hosts`；删：`ssh-keygen -R '[127.0.0.1]:2222'`）。**这是本读数唯一动到临时目录之外的东西。**
4. **应用真的连上了**（这是本次拿到的硬读数）：`compute:probe` 回
   `{"ok":true,"exitCode":0,"os":"Darwin","cpus":8,"detectedScheduler":"none"}` ⇒ 主机注册走 `compute:create({sshAlias:'127.0.0.1', sshOverrides:{user, port:2222, identityFile}})` 后，探测是应用**自己去连**的结果。
5. **顺序：会话 → id → 主机 → 提交。** 全新工程此刻**还没有会话**（`sessions.loadAll()` 轮询 60 s 仍为空）⇒ 必须先发一条无害 prompt 把会话落出来，再读 id；主机是按 **sessionId** 启用的（`compute:enabled-hosts:set(sessionId,[provider])`）。
6. **作曲器是 contenteditable**：`inputValue()` 对它无意义（报 `Node is not an <input>…`）⇒ 用 `innerText()` 读它。诊断"点击没发出去"要用：点击前读 `innerText()` + 发送钮 `isDisabled()`，点击后再读一次（清空 = 真发出去了）。

7. **提交这一环：链条是通的，但被审批拦下（下一条前提）。** 用应用自己的控制面 REPL 提交（`repl_execute({code})` 里 `host.compute.create('ssh:127.0.0.1').submit_job(intent, command, options)`），REPL 的答复是：
   ```
   {"status":"failed","traceback":"Error: Approval denied for submit_job on E2E local sshd.\n    at computeError (…/resources/notebook/repl_loop.js:1093:19) …"}
   ```
   ⇒ **REPL 看得见这台主机（报错里点着它的名字）、提交真的发起了、审批真的被问过**，然后**被自动拒绝**（屏幕上**没有**出现审批框，尽管 `settings.allowRemoteCommand` = "Allow remote command?" 那个对话框存在）。**因此下一条前提是「计算授权」**：`settings.computeGrants`（`settings/repository.ts` 的 `addComputeGrant`/`hasComputeGrant`/`listComputeGrants`）与 `PermissionGrantRegistry`（`compute/permission-grant-adapter`）；渲染端那一侧的应答通道是 `compute:respond-approval`。
   **⚠️ 一个尚未定性的问题（不要当成产品缺陷写）**：在没有授权的情况下，这次是"**问了以后自动拒绝且不弹框**"。到底是（a）该配置下的策略默认（需要先有 grant）、还是（b）审批请求**没有投递到渲染端**（与本仓已知的"订阅装了但 hub 不投"那一类同形），**本轮没有区分**——下一手先把 grant 种上/授上再提交，若**仍然**没有框且被拒，才按 (b) 立一条产品问题，并把当时的主进程日志一并附上。
   **✅ 已定性（2026-10-08，执行器读源）：见 §一之三 —— 既不是 (a) 也不是 (b)。** 真正的关口是**执行保护策略默认 `deny`**：远程面按构造恒为 `unprotected`，broker 在**任何 grant、任何卡片之前**就返回 `deny`（「问了」是误读：**从来没有请求被广播过**；grant 那条路**根本没跑到**）。⇒ **补 grant 不会有任何帮助**；要做的是先把策略改成 `Ask every time`（§一之三 给了位置与判据）。那笔误导性的报错文案（把"没人被问过"报成"审批被拒"）已同批修掉 `e1a62d75`。

**本轮的净产出**：上表 1–7 全是实测事实；`remote-job-cancel-unreachable.spec.ts` 已按仓规**删除**（从未入库），夹具里为它加的提交分支也**一并回退**（无人使用＝半截不留树）。下一次只需照 §二.4 的字段注册主机、按 §5 的顺序准备会话、**先按 §一之三 把策略改成 `Ask every time`**，就能走到"任务 running ⇒ 点取消"那一步。

## 一之三、第三次核对（执行器，2026-10-08）：§7 那个"尚未定性的问题"有答案了 —— **既不是 (a) 也不是 (b)**

**结论（读源，不是推断）**：那次「提交真发起了、审批真的被问过、然后被自动拒绝且不弹框」，**没有任何审批请求被广播过**。真正的关口是**执行保护策略**：

- `protected` 那一侧的事实：**远程面按构造恒为 `unprotected`**（`shared/execution-protection.ts` 的 `resolveExecutionProtection`：远程执行在本机无法隔离，直接返回 `level: 'unprotected'`）。
- 而策略默认值是 **`deny`**：`DEFAULT_REMOTE_UNPROTECTED_EXECUTION_POLICY = 'deny'`（同文件）。
- 审批 broker 在**任何 grant、任何卡片之前**读该策略并直接返回 `deny`：`compute-approval-broker.ts` 的 `requestWithContextOperation` 里 `policyDeniesUnprotectedExecution(policy, 'unprotected') ⇒ return 'deny'`，注释逐字写着「Under `deny` there is no card: the run is refused outright」。
- ⇒ **不是 (a)「该配置下的策略默认（需要先有 grant）」的先决条件判断错**：grant **根本不在那条路上**（策略先返回，grant 检查根本没跑到）；**也不是 (b)**：审批请求不是"投递失败"，而是**从未产生**。
- 行为本身是**设计且有用例钉住的**：`src/main/compute/compute-approval-broker.test.ts:705`「refuses an unprotected remote run under the default policy, with no card and no grant」。⇒ **不要再按"审批没投递"去立案**。

**由此得到的下一条前提（写进 §二 的前置）**：夹具必须先把策略改成 `Ask every time`（或 `Let remembered approvals cover it`），否则 `call_command` / `submit_job` / 会话缓存下载三条路都会在**卡片之前**被拒。改法是应用自己的入口：**Settings → Execution protection → "Remote execution without protection"** 那三个单选（`ExecutionProtectionPanel`，`data-slot="protection-policy-confirm|remembered|deny"`）；通道面是 `settings.executionProtection` 的 `{ action: 'set-remote-policy', policy }`。

**同批修掉一处误导（2026-10-08，`e1a62d75`）**：那条拒绝旧文案叫「Approval denied for submit_job on …」——**把"没人被问过"报成了"审批被拒"**，正是它把本单 §7 引向了"补 grant"。现在：`error_code = 'protection_refused'`（与 `approval_denied` 分开），文案里写明"没有提交任何东西、没有询问过任何人"，并指名去哪改（设置路径与选项名有**单一来源常量** + 一条把它钉在 en 字典上的守卫测试）。三条远程闸门都在卡片之前具名拒绝；策略口未接线时行为不变。

**路线 A（推荐，最省）—— 本机起一台「活的主机」**
> ⚠️ **开工第一件事（2026-10-08 追加，此前两次都栽在这里）**：把 **Settings → Execution protection → "Remote execution without protection"** 从默认的 `Refuse unprotected remote execution` 改成 **`Ask every time`**（或 `Let remembered approvals cover it`）。默认策略下 `submit_job` / `call_command` / 会话缓存下载都会在**审批卡之前**被拒（报 `protection_refused`），界面上不会有任何审批框 —— 这不是"审批没投递"，也不是"缺 grant"（见 §一之三）。
**✅ 已在本机实测跑通（2026-10-07，零安装、零系统改动、无需 docker/sudo）**：用**用户态 sshd 跑高位端口**即可得到一台真 SSH 端点。配方（全部落在 `/tmp/ps-ssh`，不动系统）：
1. 造两把密钥：`ssh-keygen -q -t ed25519 -N '' -f /tmp/ps-ssh/id_ed25519`（客户端用）与 `…/ssh_host_ed25519_key`（主机用）；把客户端公钥拷成 `authorized_keys`。
2. 写 sshd 配置：`Port 2222` / `ListenAddress 127.0.0.1` / `HostKey <主机密钥>` / `PidFile` / `AuthorizedKeysFile <那个 authorized_keys>` / `PasswordAuthentication no` / `KbdInteractiveAuthentication no` / `UsePAM no` / `StrictModes no` / `LogLevel VERBOSE`。
3. 起它：`/usr/sbin/sshd -f <配置> -E <日志>`，然后验证：`ssh -o BatchMode=yes -o StrictHostKeyChecking=no -i /tmp/ps-ssh/id_ed25519 -p 2222 "$(whoami)@127.0.0.1" 'echo SSH_OK'` ⇒ 实测回 `SSH_OK from <host>`，长命令（`sleep 5; echo LONG_DONE`）也照常返回。**本机现状**：无 docker、22 端口无 sshd、`~/.ssh` 里没有密钥对也没有 authorized_keys（所以别指望现成的，自己造）。
4. 在隔离实例里注册该主机：走应用自己的入口（设置 → 算力 → 添加主机），字段是 `compute-alias`=**`127.0.0.1`** + 高级覆盖 `compute-user`=（当前用户）/ **`compute-port`=2222** / **`compute-identity`=`/tmp/ps-ssh/id_ed25519`**；或走通道 `compute:create`。**添加后应用会自动 `compute:probe`** ⇒ 探测结果本身就是"应用真连上了"的前置读数，先断言它 ok 再往下走。
5. **⚠️ 提交任务的真实路径（2026-10-07 对源逐层纠正 —— 我此前两版都写错过，别再走弯路）**：
   - ✗ **不是**领域连接器：`sequence-tools.ts` 里那个 `submitJob` 是**同名不同物**（它 `POST ${base}/run` 到一个远端 HTTP 服务，与 `ComputeJob` 无关）。
   - ✗ **不是**笔记本/Shell 命令自动产生：应用给 agent 的 MCP 工具里**没有计算类**（`app-mcp-names.ts` 只有 activity/artifacts/notebook/skills/plan/memory）。
   - ✅ **真正的提交点**：笔记本 **Local RPC 的一个 op** —— `op === 'submit_job'`（`src/main/notebook/local-rpc-server.ts:1819-1852`），参数形状 `{ provider_id, intent, command, resources?, inputs?, outputs?, harvest?, timeout_seconds?, workspace_cwd? }`，内部调 `this.computeService.submitJob(providerId, intent, command, options, { sessionId, projectId })`。该分支的 catch 会把错误转成结构化对象**"供 JS shim 解析"** ⇒ 即**调用方是笔记本运行时里的 JS 垫片**。
   - 另一条产品纪律（`skill-doc.ts:144,160`）：agent **从不自动提交**，必须"提议并等用户批准"；审批在 `ComputeService.submitJob()` 内、**任何 DB 写入或 SSH 之前**触发。
   - **⇒ 下一手只需这一步**：查清那个 JS 垫片在单元格里暴露的调用面（notebook 运行时里怎么触发这个 op），用它提交一条长命令（`sleep 300`）⇒ 就会得到一条真 `running`、**有活派发**的 `ComputeJob`，IC39 的两半即可取证；IC40 则让同一条任务跑完（或失败）以触发一次真投递落定。
6. **IC39 的两半**：
   - 「**能送到**」：提交一个长任务（如 `sleep 300`）⇒ 等它 `running` ⇒ 点「取消任务」⇒ 断言主进程答复「已取消」+ 回读该行为 `cancelled` + 远端进程真的没了（在替身里 `pgrep`）。
   - 「**送不到**」：把替身的 sshd 停掉（或指到一个死端口）⇒ 再取一条运行中的任务点取消 ⇒ **断言那句逐字拒绝** `The host could not be reached, so the job was not stopped and is still running.` **且该行仍为 `running`**（这条才是"绝不为没人停的进程写 cancelled"的真机证据）。
7. **IC40**：让同一台替身跑一个会产出结果的短任务 ⇒ 让**投递真正发生并落定**（正常或失败皆可）⇒ 打开消息中心，断言卡面逐字 = `Background result needs attention`（`shared/notifications.ts:47`），并断言它随「打开会话 / 全部已读」被**清零**（读 + 清两侧都断，且"已读"与"已消失"分开断）。
8. 夹具按隔离实例三件齐：`--user-data-dir` + `PURESCIENCE_STORAGE_ROOT`（**同时**把 `settings.dataRoot` 指向隔离目录）+ 独立端口。

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

# A1（R1 真机验收）+ R3 真机验收 —— 2026-10-01 实测记录

方法：隔离实例（`PURESCIENCE_WEB_PORT=44170` + `--user-data-dir=/tmp/r3-ud`，**真实配置根**，构建用
`npm run build:e2e`），全部通过**应用自身通道**（loopback RPC + web-token）驱动，不靠肉眼点界面。
脚本：`/tmp/a1-r1-accept.py`（A1）、`/tmp/r3-accept.py`（R3）。探针痕迹已清理（两个探针项目 + 会话目录 +
空工作区目录，工作区计数回到基线 307）。

## A1 逐条对账（R1-slices §6 五条）

| 条目 | 结论 | 读数 |
| --- | --- | --- |
| ① 矩阵可读：四行 + 两轴取值 | ✅ **通过** | `platform=darwin`；四行 `notebook / shell / background-job / remote-host`；未改配置时 notebook 与 shell 均为 `level=os-sandbox`、`scope={filesystem: runtime-write-protected, network: allowlist}`、`applied=[managed-runtime-mutation-guard, macos-seatbelt-runtime-write, egress-allowlist]`；两行远程/后台为 `unprotected` 且带 `unmet.code=remote-execution-has-no-local-protection`。OS 写保护实测：`component=/usr/bin/sandbox-exec`、`componentPresent=true`、`available=true`。`remoteUnprotectedPolicy=deny`。 |
| ② 级别随网络轴下调并给具名原因与修复路径 | ✅ **通过** | 关掉网络允许表（`settings:set-egress {enabled:false}`）后重读：notebook 与 shell 降为 `level=unprotected`、`scope.network=unrestricted`，`applied` 中的 `egress-allowlist` 消失，并出现 `unmet.code=network-allowlist-disabled` + 英文证据句「Child-process egress is not filtered: the allowlist master switch is off, so any destination is reachable.」。脚本判据 `LEVEL_CHANGED_ON_FLIP: True`。修复路径由共享 helper `protectionRepairSteps` 从 unmet code 映射（`network-allowlist-disabled` → `enable-network-allowlist`，文案键 `protection.repairEnableNetworkAllowlist`），界面渲染在 `protection-repair-<code>` 槽位——**它不是接口字段**，所以按字段读会是 None（我第一版脚本就这么读错了）。 |
| ② 的"运行证据行显示级别" | ✅ **通过（同一实例）** | R3 那两轮真实笔记本运行的记录里带 `executionProtection`（`settings:execution-protection` 的同源快照）。 |
| ④ 无保护远程默认档 = deny（状态半） | ✅ **通过** | 矩阵 `remoteUnprotectedPolicy=deny`，与排期标题「远程默认拒绝无保护运行」一致。 |
| ④ 无保护远程**实际被拒且不留授权记忆**（行为半） | ⛔ **本机不可证** | 需要一台**可达的远程主机**（`call_command` 目标）。本机无已配置的远程主机/凭据，未伪造该路径。**卡在**：远程执行目标缺失。 |
| ③ 远程批准卡「本次执行无保护」+ 仅两个按钮 | ⛔ **本机不可证** | 同上：批准卡只在一次真实远程执行发起时出现。**卡在**：远程执行目标缺失。 |
| ⑤ 平台能力缺失路径（无 OS 写保护平台 → 「仅网络允许表」+ 说明） | ⛔ **本机不可证** | macOS 上 `sandbox-exec` 存在且可用（见 ①），该分支在 darwin 上无法呈现。**卡在**：需要一台本构建无 OS 沙箱适配的平台（Windows/Linux）。 |

**不改动用户配置**：脚本先读 `settings:get-egress` 原样，改完再**原样写回**，并以**归一化行进**
（去掉 `capturedAt` 时间戳）比较，读数 `RESTORED_IDENTICAL: True`。矩阵整体比较必然不等——它带采集时间戳。

## R3 真机验收

| 判据 | 结论 | 读数 |
| --- | --- | --- |
| 一轮真实执行记录「读入了哪些既有文件」 | ✅ **通过** | 真笔记本单元 `open('input.csv').read()` → `status=completed`，记录里 `fileEvidence.read=[{path: …, relativePath: 'data/input.csv', kind: 'input', reads: 1}]`、`readStatus='captured'`。会话相对路径正确（`data/…`）。 |
| 解释器自身的 import 不进证据 | ✅ **通过** | 第二轮 `import os` + `1+1` → `read=[]`、`readStatus='captured'`（**空清单**，不是字段缺失）。 |
| 「未捕获」与「确实没读」可区分 | ✅ 由契约与用例保证 | 驱动不报时字段缺失 → 记录写成 `unsupported{reason}`；报空数组才是「确实没读」。 |

### 真机抓到的缺陷（已修，见 R3-U2c）

第一轮我把探针文件放错目录，单元因此**打开失败**（FileNotFoundError），但运行记录仍把它记成
`kind: 'input', reads: 1`：审计钩子在 open **真正执行前**触发，失败的打开与成功的读入在数据上同形。
即「读入」这一列会对一个**从未读到的文件**说它被读了。修法：驱动在收尾处判定存在性并把 `present`
随条目报出，契约新增第三种读入 `'missing'`（优先于写入集合判定），界面把它从读入表移出、改为带路径的提示。
（我先前那次真机探针读的是**存在**的文件，所以没暴露这一条——这也是"只跑happy path 不算验收"的例子。）

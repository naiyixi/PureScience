# 单元 10 真机取证：`.science` 会话包携带文献 PDF + 导入只读（2026-09-22）

结论先写：**这一半此前是坏的**。包不携带任何文献 PDF；导入出来的会话在应用自己的校验下非法、被隔离；
"只读"只是一份没人读的记录。三处都是单测全绿、只有真机才暴露的缺陷。现在三处都已修复，并在隔离实例上
完成了端到端取证。同批顺带查证了单元 10 的其余子项（NCBI 参考工具 / 连接器批量启停 / CLI `init`·`doctor`）
——**三项早已交付**，本轮按"架构已覆盖"零代码结案，附实机证据。

## 1. 隔离实例配方（本轮实际使用，含两处对旧配方的修正）

```bash
PURESCIENCE_WEB_PORT=44152 PURESCIENCE_STORAGE_ROOT=/tmp/ps-verify-root \
  npx electron-vite dev -- --user-data-dir=/tmp/ps-verify-profile \
    --remote-debugging-port=9223 --disable-gpu
```

- **修正一：必须带窗口（去掉 `--purescience-headless`）+ 远程调试端口。** `.science` 的
  `sessions:export-package` / `previewPackage` / `importPackage` 是 **Electron 专属通道**
  （不在 `src/shared/web-api-map.generated.ts` 的 web RPC 面上），无头实例没有窗口就永远驱不到。
  驱动方式：CDP attach 到 `http://localhost:5174/` 的渲染页，在页面上下文调用 `window.api.*`
  （真渲染层 → 真 preload → 真 IPC → 真 owner）。
- **修正二：`PURESCIENCE_STORAGE_ROOT` 在 dev 下就是"配置根"**（`src/main/storage-root.ts`：
  `resolveConfigRoot = resolveStorageRoot`），DB/sessions/settings 全部搬走；但**数据根默认仍指向
  `~/PureScience-DEV`**（`computeDefaultDataRoot`）。因此在隔离根的 `settings.json` 里必须显式设置
  `dataRoot`，否则受管文件（上传、产物）会写进用户真实数据根。本轮 `dataRoot=/tmp/ps-verify-root/data/PureScience-DEV`。
- 判断实例起没起看**端口 LISTEN**；用户正在使用的 44100 实例全程未碰（其进程与端口自始至终未变）。
- 收尾清理：先 `chmod -R u+w` 再 `rm -rf`（本次清理 5.8 MB + 125 MB 两个根，证据留在 `/tmp/ps-verify`）。

## 2. 取证链路与数字

| 环节 | 实物 | 结果 |
|---|---|---|
| 项目 | `zz-verify-science-pkg` | 建项目 → 上传真论文 PDF `attention-is-all-you-need.pdf`（arXiv 1706.03762，**2 215 244 B**）→ 文献库记录 `Attention Is All You Need` 挂上该 PDF（`pdfContentHash` = `sha256:bdfaa68d…:2215244`） |
| 真会话 | `ae46e45b-d806-4e6c-9219-a2e92cc176c4` | UI 真发送（`[role="textbox"]` 聚焦 → 输入 → `Escape` 关历史浮层 → `button[aria-label="发送消息"]`），**真 agent 回合 1m18s**，agent 用内置 PDF 工具读满 15 页并核对摘要里的 BLEU 数字 |
| 导出 | `zz-verify-full-v2.science` | **1 160 875 B**，`counts.referenceFiles = 1`；包内成员 `references/Attention Is All You Need.pdf` 2 215 244 B |
| 导出（精简） | `zz-verify-essential-v2.science` | 16 040 B，具名 `reference-pdfs-not-requested:1`（不读字节就报数） |
| 独立复核 | python `zipfile` 逐条重算 | **29/29 全过**：每条 sha256/字节数与 manifest 一致；`references/…pdf` 与源论文**逐字节相同**；与应用自己记录的 `ManagedFile.checksum`、磁盘上的源文件**三方一致**；文献指纹（前 4 MiB sha256 + 精确字节数）独立重算一致；manifest 不含自身条目；`assertion.locallyVerified === false` |
| 导入 | `85293f16-…` | `ok`、posture `readOnly/executeAllowed:false/continueAllowed:false`；读回 7 条消息完整转录、`createdAt` 保留来源机值 1 790 013 637 748 |
| 只读强制 | 同上 | `acp.resumeSession` **被拒**（具名句）；对照组：本机自己的会话 `ae46e45b` 照常 resume 成功 |
| 扫描存活 | 同上 | 导入后连做两次 `sessions.loadAll()`：`diagnostics.warnings = []`，只读记录 `85293f16-….import.json` 仍在原处 |

## 3. 三处缺陷 + 一处连带缺陷（均已修复）

### 3.1 文献 PDF 从未随包走（导出侧）

- 症状：真机导出 `counts.referenceFiles = 0`，包 16 KB，精简包连 `reference-pdfs-not-requested` 都没有。
- 根因：`src/main/ipc.ts` 的 `referenceFiles` 端口用 `ReferenceRepository.listAttachmentVersions()` 取"当前附件"，
  而 `ReferenceAttachmentVersion` **只记录被替换掉的旧文件**（`repository.attachPdf` 仅在换/解开时写一行历史）；
  当前附件在 `Reference.pdfManagedFileId` 行字段上 ⇒ 新挂的 PDF 永远查不到，循环里 `continue`。
- 修法：抽出 `currentReferencePdfId` + `createSessionPackageReferenceLibrary`（`src/main/session-package/reference-files.ts`），
  wiring 只接端口；新增读源码守卫 `reference-port-wiring.test.ts`（断言 ipc 侧出现 `createSessionPackageReferenceLibrary(`
  且**不得**出现 `listAttachmentVersions`），6 条真实形状用例。
- 提交：`e1f99d3`。

### 3.2 导入落成一个"打不开的会话"（导入侧）

- 症状：`sessions:import-package` 返回 `ok:true`，但会话文档被应用判为损坏并隔离成
  `48487f7c-….json.invalid-1790014117467-1`（catalog 读 `outcome: 'partial'`, `warningCount: 1`）。
- 根因：导出的 `conversation.json` 只有 `{messages, artifacts}`（无会话级时间戳），导入方据此写出的会话文档
  缺 `createdAt/updatedAt`；`createLinearConversationGraph` 于是产出**没有时间戳的帧与分支**，而
  `sanitizeConversationGraph`（`src/shared/session-persistence.ts`）要求帧有 `createdAt`、分支有
  `createdAt`+`updatedAt`，缺则丢弃 ⇒ `validateConversationGraph` 抛错 ⇒ `normalizeSessionFile` 返回
  `undefined` ⇒ 隔离。类型上 `createdAt/updatedAt` 是必需字段，旧实现用 `as PersistedChatSession` 断言绕过了检查。
- 修法：导出侧 conversation 切片携带 `createdAt/updatedAt`（`service.ts`）；导入侧用包内值、旧包按导入时刻落章
  （`import-session.ts`）；owner 写入真实时间戳（`import-owner.ts`）；新增"写出的文档必须通过应用自身
  `createSessionFile`→`normalizeSessionFile` 往返"的用例 + **反向基线**（抹掉时间戳则同一文档被判 undefined，
  证明时间戳就是承重件）。提交 `e1f99d3`。

### 3.3 "只读"没有任何读取方（执行侧）

- 症状：`readSessionPackageImportRecord` 全仓**零消费者**（grep `src`：只有定义与写入两处）；导入的会话可被
  `acp:resume-session` 正常恢复并执行。
- 修法：在 resume（唯一让"恢复的会话"变得可执行的门）按名拒绝，判定源就是导入记录本身
  （`readSessionPackageImportRecord(configRoot, projectId, sessionId)`，与写入同源）；检查失败按"非导入"处理
  （记录损坏=无记录是既有契约，且瞬时读失败不得锁住用户自己的会话）。三条例程：拒绝且 runtime 未被触碰 /
  本机会话照常 / 检查抛错不锁死。提交 `e1f99d3`。
- 真机：拒绝文案 `This session was imported from a session package and is read-only: it can be read and cited, not run.`；
  对照会话正常 resume。

### 3.4 连带：只读记录自己被扫描隔离（持久层）

- 症状：导入后第一次全量扫描把 `<会话>.import.json` 当会话文档读，归一化失败 ⇒ **当作损坏文件隔离**
  （`.import.json.invalid-1790014611493-1`），只读姿态就此消失，之后导入会话恢复可执行。
- 修法：会话目录扫描排除导入记录（与 `.summary.json` 同等待遇，`src/main/session-persistence/repository.ts`）；
  测试在真实会话旁写一份记录，断言扫描后"只列会话、零告警、文件仍在"。提交 `00380f6`。

## 4. 单元 10 其余子项：查证后零代码结案（附实机证据）

| 子项 | 现状 | 实机证据 |
|---|---|---|
| NCBI 参考工具（§3.5） | **已交付**：`src/main/connectors/descriptors/genomes-ncbi.ts` 的 `ncbi_reference_sequence` / `ncbi_reference_region`，SHA-256 对**收到的原始字节**、字节数与碱基数、`assembly` 断言 fail-closed、超限截断如实标注 | agent 走应用内连接器取 `NM_000546.6`：返回 `sha256 070de27f7b9df05889c79d148333fb9f939c974cef697719656004f936827b4c` / `bytes 2626` / `length_bases 2512` / `identifier NM_000546.6`，与 python 独立重算**逐字一致**；带 `assembly: GRCh38` 的调用对转录本记录**按设计拒绝**（"Refusing rather than labelling a sequence with an assembly it was not fetched from."） |
| 连接器批量启停 | **已交付**：`SetConnectorsEnabled*` 契约 + `settings:set-connectors-enabled`，逐项返回 `changed/error` 与 `changed/unchanged/failed` 计数 + `appliedAt` | 隔离实例实调：25 个连接器上一次性提交三项（改一个 / 一个已同态 / 一个不存在的 id）→ `changed 1 / unchanged 1 / failed 1`，失败项带 `unknown connector: zz-no-such-connector`；探针已把改动复原 |
| CLI `init` / `doctor` | **已交付**：`packages/purescience/doctor.mjs`（`runInit`/`runDoctor`/`formatInit`/`formatDoctor`）+ `cli.mjs` 两个子命令 | 真跑：`init` 在隔离根创建 0700 目录、不写任何设置；`doctor` 报 `config_root / service_state / web_token / app_binary / node` 实测事实，**明确拒绝做就绪判定**（"就绪判定不在这里：`purescience ready` 会给出应用侧的就绪结论"） |

## 5. 本轮未取证 / 边界

- 文献 PDF 携带链路的证据覆盖**引擎+端口+IPC+真实文件**四层；**打包版**（`.app`）未复跑本链路（隔离实例为 dev 构建）。
- 导入的**只读姿态对 UI 的可见性**未做：拒绝发生在 main 侧（resume），界面不会提前把输入框置灰。
  这是本轮已知边界，未声称"界面上看得出来"。
- `additional_evidence`：包与证据留存 `/tmp/ps-verify/`（`out/*.science`、`evidence/quarantined-imported-session-before-fix.json`、
  `evidence/import-record.json`、`ncbi-independent.json`、`connector-batch.json`）；隔离根/档案已按规矩清理。

## 6. 质量基线

- 双 typecheck 干净；全树 `eslint --no-cache .` **0 error**（129 条既有 prettier warning，非本次引入）。
- 全量 `npx vitest run --maxWorkers=4`：**1069 文件 / 14 184 用例通过**（15 文件 / 191 用例按设计跳过）。
- PR #10 门禁：PR Gate / Static checks / Module tests / Windows core / macOS build+E2E / Windows E2E 全绿
  （唯一红的 `Review / Run Codex` 卡在 `Prepare Codex authentication`，是咨询性作业的认证问题，不属门禁）。

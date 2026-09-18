# v1.64.0 之后未收口的项（立案，不留在汇报里）

v1.64.0 已发布（`477b1a9`，tag `v1.64.0`，Release 19 资产）。这份档把这一批**明确没做完**的事落到条目上，每条都带判据与"为什么现在没做"，避免它们只活在一次会话汇报里。

## 1. 启动协调仍是全量（水位增量未做）

- **现状**：协调（上传升级 / 产物恢复 / 文件索引同步 / 权限清理）已从列表读挪到**进程启动跑一次**，但那一趟仍是**逐会话全量** —— 真机日志：`phase: 'reconcile-derived-state', outcome: 'completed', durationMs: 2559`（59 会话）。
- **判据**：启动那趟 **< 1 s**（同一 59 会话语料）。
- **为什么没做**：它是独立单元；本轮只把"列表读"这一半做掉。**现在有了落盘索引**（每会话 size+mtime 指纹），水位增量的判据已经具备：只有指纹变化的会话才需要重解析＋重协调。
- **证据位置**：`docs/evidence/2026-09-18-incremental-catalog-index.md` 第三节、第四节第 5 条。

## 2. 打包版未复测（这批数字全是 dev 构建）

- **现状**：列表层的 `569,858 B / 68.2 ms / p95 23.2 ms`、以及护栏真机路径，都在 **dev 构建**（`electron-vite dev`）上取的；打包版上一次实测的 `load-all` 是 **55.4 MB / 1191–1566 ms**（同量级）。
- **判据**：打包版上以**同一量法**复测列表层与 `read-document` 两项，并复跑一次护栏真机路径（Pin 未打开的会话 ⇒ 文件逐字节不变）。
- **为什么没做**：本轮窗口验证要的是"能驱动真实 UI"，dev 构建能满足且更快；打包版 CDP 时开时不开（已另案）。
- **证据位置**：同上，第四节第 1 条。

## 3. 除 Pin 以外，没有逐条真机取证其他编辑路径

- **现状**：只有 **Pin**（`togglePinned`）在真实窗口里被驱动过 —— 它是"换对象"型编辑的代表。**rename / 归档 / 其他走 saver 的路径**没有逐条真机取证。
- **判据**：每条路径在"仅摘要"状态下**要么被拒（文件逐字节不变），要么写完整文档（消息条数与列表/图/索引三处一致）**；绝不出现静默截断。
- **为什么没做**：它们共用同一个 saver 拒写条件，机理已被 2 条回归用例钉住；但"共用条件"是推理，不是取证 —— 按本仓规矩，推理不记为已完成。
- **证据位置**：`docs/evidence/2026-09-18-lazy-guard-live-verification.md` 第四节第 4 条。

## 4. 默认并行度下"全量门禁"不可信（已修 2 条，剩余已定性）

**已修（本轮）**：两条遍历 `src/renderer/src` 全树的用例（`session-store.test.ts > keeps production consumers on the public store facade`、`settings-store.architecture.test.ts > keeps owner imports private and consumers on the documented public store surface`）在并行下会 **`Test timed out in 15000ms`**（实测 19.8 s / 20.4 s）——**不是断言失败**（报告里打印的 `violations…` 只是超时的源码上下文，读错会以为架构边界被破坏）。两条都加了 `}, 60000)` 与具名注释。
- **修复前**：同一 scope（28 文件）连跑 3 次 = **2 红 1 绿**；单跑该文件 5/5 绿（约 1 s）。
- **修复后**：同一 scope 连跑 **4 次 = 4 绿（538/538）**，两条用例不再出现在任何失败列表里。

**剩余（已定性，未逐条改）**：默认并行度的全量跑在该机上**仍不可能绿** —— 实测 `npx vitest run`（默认 workers，机器同时跑着常驻 headless 实例）**12 文件 / 72 例红**，种类分解：**15 条超时** + **约 40 条级联断言**（`expected "vi.fn()" to be called once, but got 0 times` / `expected undefined to be defined` / `expected '' to contain …` —— 都是 `vi.waitFor` 在 CPU 饱和下等不到）+ **2 条 `ENOTEMPTY: directory not empty`**（临时目录清理竞态）。同一份代码 `--maxWorkers=4` 全量 **0 红**。
- **结论**：它们是**负载产物**，不是代码缺陷；但"全量门禁绿"这句话在默认并行度下不成立。
- **机制（已加）**：`npm run test:gate` = `vitest run --maxWorkers=4`（本机 8 核 8 GB，实测 0 红 / 约 400 s）。本机全量门禁一律用它，别再靠"记得加参数"。**CI 不受影响**（CI runner 的 `Verify` 一直是绿的）。
- **仍可做（未做，独立单元）**：给重负载套件（`WorkspaceMessageScroller.*`、`PreviewFileContent`、`runtime-service` 等）单独放宽超时，或把 worker 上限直接写进 CI 的重负载 job —— 现在这一步只覆盖"本地怎么跑"，不覆盖"CI 上换 runner 后会不会再抖"。

## 5. 无需动作，仅备忘

- 索引格式 v1 → v2 的升级成本 = **一次全量回退读**（真机 503.5 ms / 59 解析），之后恢复零解析；已写入 CHANGELOG。
- `windows-upgrade-smoke` 在 workflow 里是**非阻塞**的历史演练，本次红而 Release run 结论为 `success`（已在发版汇报里如实标注）。

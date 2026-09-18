# v1.64.0 之后未收口的项（立案，不留在汇报里）

v1.64.0 已发布（`477b1a9`，tag `v1.64.0`，Release 19 资产）。这份档把这一批**明确没做完**的事落到条目上，每条都带判据与"为什么现在没做"，避免它们只活在一次会话汇报里。

## 1. 启动协调仍是全量（水位增量未做）—— **已量：文档水位救不了它（本批更新）**

- **现状**：协调（上传升级 / 产物恢复 / 文件索引同步 / 权限清理）已从列表读挪到**进程启动跑一次**，但那一趟仍是**逐会话全量**。
- **本批把它拆开了**（真机 dev 实例 + 真实语料副本 + 59 会话；新增 `scanDurationMs` 计时后一次运行就读到）：

| 组成 | 实测 |
|---|---|
| **扫描文档**（`load-authority`，全量解析 59 份） | **512 ms** |
| **派生状态协调**（`reconcile-derived-state`：上传/产物/文件索引/权限） | **1336 ms** |
| 该趟合计 | **≈1.85 s** |
| （同次运行的 `install-lifecycle` 4753 ms、`fetch-manifest` 2836 ms 与应用启动/联网有关，不计入本项） | — |

- **结论（改变了这条的写法）**：**文档水位增量最多省掉 512 ms 里的一部分**，而 `reconcile-derived-state` 那 1336 ms 吃的是**整份文档 + 产物存储/文件索引 DB 的状态**，文档没变也必须跑（`artifact-finalization-recovery.integration.test.ts` 保护的正是这种"文档未变但需要恢复"的场景）。
  ⇒ **原判据「启动那趟 < 1 s」用文档水位达不成**（理想水位也只省 ~0.5 s / 1.85 s）。
- **要重开的设计**：想真正缩短，得对 `reconcile-derived-state` 做增量，而它的水位不能只看文档指纹 —— 需要**产物存储 + 文件索引 DB 的按会话修订**作为第二把尺，并且必须先证明"存储侧无变化即可跳过"（现有恢复用例是这条证明的靶子）。**这是设计问题，不是"照单执行"**。
- **顺手留下的产品价值**：`scanDurationMs` 现在写进 `session-hydration` 的完成日志（此前只有 `reconcile-derived-state` 有耗时，扫描那半**完全不可观测**，正是我这次先卡住的地方）。
- **证据位置**：`docs/evidence/2026-09-18-startup-pass-attribution.md`。

## 2. 打包版未复测（这批数字全是 dev 构建）—— **已复测（2026-09-18，本批完成）**

- **结论**：已在**打包版**（`dist/mac-arm64/PureScience.app`，`cc79289` / 1.64.0，独立端口 44101 + 独立 user-data-dir）上以同一量法复测：列表层 **572,705 B / 冷启动 65.1 ms / 稳态 p95 25.0 ms**；`read-document` **43.2 ms**；同实例 `load-all` 基线 **55,374,379 B / 1368.3 ms**；删索引后第一次 **433.9 ms**（59 解析）→ 下一次 **16.1 ms**（零解析）；服务端计数只出现 `(59,0)` 与 `(0,59)` 两种形态。**护栏真路径也在打包版窗口上复现成立**（Pin 未打开的会话 ⇒ 逐字节未变；读到文档后同一动作 ⇒ 写入且 9 条消息完整，列表/图/索引一致）。
- **新坑（已记档）**：打包版在隔离根里若没有 `runtime/`，会**卡在 `compose-runtime` 且不打任何错误**；`cp -al ~/.purescience/runtime <copy>/runtime` 即恢复。
- **证据位置**：`docs/evidence/2026-09-18-packaged-1.64.0-reverification.md`。
- **仍未覆盖**：Windows / Linux 打包产物、以及打包版的 UI 交互帧率。

## 3. 其他编辑路径真机取证 —— **已完成（2026-09-18，本批）**

- **结果（打包版真实窗口 + 真实鼠标，`docs/evidence/2026-09-18-guard-other-edit-paths.md`）**：
  - **重命名**（走 store saver）：摘要态 ⇒ 文件 **323,416 B 逐字节未变**（mtime 与 sha256 都不变、消息仍 9 条）⇒ **被拒**；读到文档后再重命名 ⇒ 标题落盘 `RENAMED-BY-PROBE-2`、**消息仍 9 条** ⇒ **生效且未截断**。
  - **归档**（走 main 侧 `sessions:update-archive`，不经 saver）：摘要态 ⇒ **生效**（`archivedAt` 已写）且 **33 条消息未截断**。
  - ⇒ "该拒的拒、该过的过"，**没有静默截断**。
- **仍未覆盖**：菜单里其余项（下载产物 / 导出会话 / 删除）未逐条驱动；dev 侧未复跑这两条（pin 那条两侧都有）。

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

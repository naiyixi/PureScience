# 认证读数台账（2026-10-10 对账）—— 「未取」逐条对着车道日志与仓内证据核过

> 立档：自主执行器（2026-10-10）。这份档是一个**动作的产物**：把活档里所有「未取 / 未实测」的读数主张
> 逐条核一遍，核到的状态写死在这里。它替代不了那些活档本身（对应处已就地更正），但它是**唯一一份
> 带判据的汇总**：每条都说清「凭什么这么判」。

## 0. 这份台账治的是哪一类失真

两轮里同一类失真反复出现：一条读数**已经取到**（本机真机运行 + 证据档逐字 + spec 在树），活档却把它记成
「未取」并逐轮挂账。成因不是懒，是**只核了一半**：

- 核了**车道日志**（对的那一半，见 `scripts/ci/harvest-certification-readings.mjs`）；
- 没核**仓内自己记了什么**（另一半）。

而认证车道上有一批 spec 带 `test.skip(...)` 守卫：它们需要**本机前置**（curated runtime pack / scanned fixture /
用户态 sshd），车道上没有前置就跳过，**跳过的用例一行都不打印**。于是「车道日志零 `[tag]` 行」对应两种完全不同的世界：
①没人取；②取了、但那台机器上没有前置，所以该 spec 在车道上没跑。把①的判据用在②上，就是把已交付写成未做。

**本轮新增的工具**（本技能自带的 `scripts/ci/` 之外，仓内 `scripts/ci/harvest-certification-readings.mjs` 加了 `--in-repo`）：
一条命令列出「仓里哪一处记着这条读数」以及**全部守卫清单**，让上面那一半也变成可跑的：

```
node scripts/ci/harvest-certification-readings.mjs --sha <完整 40 位>     # 车道侧
node scripts/ci/harvest-certification-readings.mjs --in-repo <tag>       # 仓内侧 + 守卫清单
```

两条都空 ⇒ 才是「未取」。

## 1. 车道侧的第一手读数（本轮实取，绑到完整 40 位 SHA）

- 提交 `47de6229bbe8b8197eb851405d350e3b586215cd`（= 开工时 `origin/main` 的尖端）。
- `Nightly` run **`38007418098`** = **success**，8 个作业逐个 success（`Resolve platform matrix` / `Verify (lint + typecheck + test + package)` /
  `Build linux-x64` / `Build macos-x64` / `Build macos-arm64` / `Build windows-x64` / `publish`）。
- `Windows Full Test` run **`38007417905`** = **success**。
- 认证作业（`macos-arm64`）= **`114083015561`**：`88 passed / 12 skipped / 1 flaky (28.2m)`，
  平台判决行 `electron_p0=passed` / `visual_regression=passed` / `package_smoke=passed`；
  该作业的读数规模 `specs=102 / readings=200 / tags=49`。
- **该作业没有上传 Playwright 报告产物**（run 的四个资产都是 ~550 MB 的应用包）⇒「哪 12 条被跳过」没有名单，
  只能由仓内守卫推得，见 §2 与 §4 的「本轮没证到什么」。

## 2. 车道上的 12 个 skip 与仓内的 12 个守卫**计数逐一对上**

| 文件:行 | 守卫条件（逐字） |
| --- | --- |
| `e2e/certification/kernel-controls.spec.ts:77` | `!existsSync(PACK_LOCK)` — `no curated pack on this machine` |
| `e2e/certification/lock-import.spec.ts:79` / `:170` | 同上 |
| `e2e/certification/lock-import-download.spec.ts:134` / `:178` / `:200` | `!lockExists()` — 同上 |
| `e2e/certification/named-env-kernel-in-use.spec.ts:94` | 同上 |
| `e2e/certification/notebook-interrupted-run.spec.ts:102` | 同上 |
| `e2e/certification/notebook-runtime-binding.spec.ts:84` | 同上 |
| `e2e/certification/packages-mutation.spec.ts:180` | 同上 |
| `e2e/certification/pdf-scanned-pages.spec.ts:21` | `!existsSync(SCAN_PDF)` — `no scanned fixture on this machine` |
| `e2e/certification/remote-job-cancel.spec.ts:256` | `!endpointReachable()` — `no user-mode sshd on 127.0.0.1:2222` |

合计 **12** 条守卫（9 个文件），与车道报告的 **12 skipped** 数目相同；且 CI 机上没有 `~/.purescience/runtime/packs`
（`grep -rn "runtime/packs" .github/workflows/ scripts/` 零命中 ⇒ 没有任何步骤铺设它）⇒ 守卫条件在这台机器上为真。
**可复跑**：`node scripts/ci/harvest-certification-readings.mjs --in-repo <tag>` 会把这 12 条原样打出来。

## 3. 逐条对账（活档里每一处「未取 / 未实测」）

| # | 主张（出处） | 核到的状态 | 判据 |
| --- | --- | --- | --- |
| 1 | **A7 下载路径**未实测（队列档 ¶64、¶116；§四十三 §三；§四十四 §六；`docs/evidence/2026-10-03-A7-external-lock-import.md` §3 第 1 条、§5.2、¶140） | ✅ **已取（本机真机）** | 提交 `f41580d8`；spec `e2e/certification/lock-import-download.spec.ts` **3 passed (46.2s)**；读数十字在 `docs/evidence/2026-10-04-v5-lock-import-download.md`：`[v5] status: Imported “download-env” — 82 packages (81 from cache, 1 downloaded).`、`[v5-off]` 具名报缺、`[v5-bad]` 整份拒绝且不建环境。车道侧 skip（守卫 `lockExists()`）。 |
| 2 | **「在用内核时拒绝移除」**真窗口读数未取（队列档 ¶68、¶153；排期档 IC8 行；同一份 A7 证据档 ¶140） | ✅ **已取（本机真机）** | spec `e2e/certification/named-env-kernel-in-use.spec.ts` **1 passed (1.3m)**；读数在 `docs/evidence/2026-10-04-v6-kernel-in-use-recipe-refuted.md` §第三版：状态表里 `python:lock-import-env` 为 `idle` ⇒ 移除被**逐字拒绝**、环境目录仍在。车道侧 skip（同一守卫）。 |
| 3 | **IC39（远程任务取消）**「该读数仍然未取」（§四十一 §三 末行） | ✅ **已取（本机真机）**；车道侧确实未取 | 提交 `0d1fa31c`（spec 在树，`git log` 只有这一笔）；读数四步在队列档 §三十五：默认策略拒（无卡片、零 job 行）→ `Ask every time` + 卡片「Once」真派发（主机上真有 1 个 `sleep 300`）→ 窗口停止 ⇒ 行 `cancelled`、主机 `sleeps=0` → 拿走主机再停止 ⇒ 主机不可达逐字上屏、**行仍是 `running`**；`1 passed (18.2s)`。车道侧 skip（守卫 `!endpointReachable()`）⇒ 「车道上没有」与「没取过」不是一件事。 |
| 4 | **IC17 收紧后 spec 的机器判决**未取（§四十四 §六） | ✅ **已取（车道）** | 车道读数 `[ic17] renderer received 162 broadcast(s); 160 carried the nested download detail … "hasDownload":true` + `[ic17] panel percent samples: 1, 2, 3, 4, 5, 6, 7; shared line rendered: true`（§四十一 §三 表内已列，本轮复取一致）。 |
| 5 | **IC16 逐 tick 屏上读数**未取（§四十四 §六） | ✅ **已取（车道）** | 车道 `tags` 里 `ic16` / `ic16-cdn` 均在场（同一作业）。 |
| 6 | **IC49 别名解绑真机读数**未取（§四十四 §六） | ✅ **已取（车道）** | `[ic56alias] the confirm says: "After this, “nature” will no longer resolve to Nature (London)…"` → `after the release: aliases=[]`（§四十一 §三 表内已列，本轮复取一致）。 |
| 7 | **IC40 needs-attention 卡**真机读数 | ⛔ **确实未取** | 全树没有这支 spec：`grep -rn "needs-attention" e2e/` 零命中；且难点已查明（手种的行不会被应用自己的机器认领）⇒ blocked-by **一条真的后台投递**（需真算力主机 / 可注入接缝）。 |
| 8 | **IC6「已收割」**读数 | ⛔ **确实未取** | `grep -rn "featured\|harvest" e2e/certification/*.ts` 零命中 ⇒ 本机取不到，blocked-by **真算力主机**。 |
| 9 | **中文源四家连接器** | ⛔ 未取（外部条件） | 四源仍只回 `text/html`（2026-10-09 复测的字节数在交接档 §四 第 5 行）。 |
| 10 | **M2 / IC54 本地解析模型资产** | ⛔ 未取（产品决定） | 无任何已发布 SHA256 的权重清单 ⇒ 按「无校验值不下载」保持顺延。 |
| 11 | 交接档 §四 **第 2 项「读数归属细化到逐 run」** | ✅ **已交付** | v1.95.0（提交 `ac565350`，CHANGELOG v1.95.0 §「逐 run 归属 ✅」；认证 spec 侧断言 `c30c209f`）⇒ 该行「blocked-by 投影正被另一轮改 + 需要可信 run id 通道」**已不成立**。 |
| 12 | 交接档 §四 **第 3 项「校验器回挂」** | 🚧 **在飞（别人的）** | 桌面会话的在制品 `src/main/connectors/reading-verifier.ts`(+`.test.ts`) 等 30 条路径 ⇒ 不是缺项、本轮一位未碰。 |

## 4. 本轮没证到什么（不许当已验）

- `--in-repo` 只证明「仓里记着这条读数」，**不判断读数真假**；读数的真假由它自己的证据档与 spec 承担。
- 「12 skipped ↔ 12 守卫」是**计数对上**，不是逐条确认：车道报告只给总数、该作业也没上传 Playwright 报告产物，
  所以「哪 12 条被跳过」是**推得**的（守卫条件在 CI 机上为真 + 日志零 `[tag]` 行 + 每条只跑 5–6 秒）。写进台账的
  是「这 12 条守卫在车道上必然跳过」，不是「车道逐条确认了名单」。
- 本轮**没有起过 Electron**、没有取任何新的真机读数；上文所有读数都来自 CI 作业日志或既有证据档（逐条注明了出处）。

## 5. 对账留下的动作（都已落，见队列档 §四十五）

1. 队列档 ¶64/¶68/¶116/¶153 与 §四十一/§四十三/§四十四 里那几处「未取」**就地更正**（保留原判断的痕迹，只加更正句）。
2. 排期档 **IC8 / IC39** 两行就地更正。
3. 证据档 `2026-10-03-A7-external-lock-import.md` §3/§5.2/¶140 与另外两份证据档里被点名的挂账**就地更正**。
4. 交接档 §四 第 2 项改为已交付、§六 的建议重排；本台账落 `docs/evidence/`。
5. 工具补上仓内那一半（`--in-repo`），并把守卫清单变成它每次都会打印的东西。

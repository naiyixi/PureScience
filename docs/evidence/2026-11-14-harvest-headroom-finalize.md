# 收割前的余量闸：读数取不到时也要给出终态，失败路径的通知不再被一行时序错吃掉

日期：2026-11-14（执行器）
触发来源：`docs/plan-2026-10-03-next-queue-and-round-convention.md` §三百二十九 §四「具名未办」第 1 条。

## 一 为什么是这一处

`src/main/compute/harvest-engine.ts` 的收割在下载前有一道 2 GiB 余量闸（与参考实现同口径）。它原来的形状：

```ts
const available = await availableBytes(storageRoot)
if (available < computeHarvestDiskHeadroomBytes) { … finalizeAndReturn(…, '[]'); return }
```

`availableBytes` 只在**卷本身读不出来**时抛（「目录还没建」那一类触发面已由 `8dbf5caa` 消掉）。抛出去的那一刻：

- 这一笔收割还没有写任何 `harvestedAt` ⇒ 一个**已经跑完的远端作业**与「收割从来没开始过」在库与界面上完全同形；
- `job-poller` 的 `_runHarvest` 只把它记成一行 `harvest failed before recording a result`（这一次那句恰好是真的，但它同样是失败路径唯一的可观测面）；
- 调用方拿到的是一个异常，而不是一个带原因的终态作业。

同一批用例还逼出**一个更早就存在的缺陷**（不是本次改动引入的，下面第二节有取证）。

## 二 顺带被用例逼出来的：早退路径上的通知从来没发出去过

`finalizeAndReturn`（HEAD 里第 282 行）引用 `buildAndBroadcastNotification`，而后者是同一个函数体里**靠后**声明的 `const`（HEAD 第 307 行）。于是：

- 只有在 `deps.broadcast` 有值、且走到**早退**路径时才会踩到——此时 `finalize()` 已经把行写好了，紧接着 `buildAndBroadcastNotification` 撞上暂时性死区，抛 `ReferenceError: Cannot access 'buildAndBroadcastNotification' before initialization`。
- 生产里 `broadcast` **永远有值**：`src/main/compute/job-runtime.ts:37` 取 `adapters.broadcast ?? broadcastJobUpdated`，并在 `harvestFn` 里逐字段传给 `harvestJob`。
- 结果：主机查不到 / SSH 目标解析失败 / 远端枚举失败 / 余量不足，这四条早退路径在生产里**写完了行、抛了异常、一次 compute_done 通知都没广播**，而 `job-poller` 把它记成「记录之前就失败了」——那句与事实相反。

取证：`git show HEAD:src/main/compute/harvest-engine.ts | grep -n "const finalizeAndReturn\|const buildAndBroadcastNotification"` ⇒ `282` 在前、`307` 在后。既有用例里唯一带 `broadcast` 的两条（成功路径 / 下载失败路径）都在声明之后才调用，所以这条时序错一直绿着。

## 三 改动

`src/main/compute/harvest-engine.ts`

1. `HarvestDeps` 增加可注入的 `availableBytesFn`（缺省仍是真实现）。原来这里是**直接 import 调用**，两种失败形状——「低于阈值」与「卷根本读不出来」——在本机都无法构造，于是这道闸至今一条用例都没有。
2. 读数用 `try/catch` 包起来。取不到时**fail-closed**（不开始下载一个无法与磁盘比大小的量），但仍然**必须落终态**：
   `harvest skipped: disk headroom could not be read (<原因>)；the remote files were not enumerated and remain in <workdir>`。
3. 余量不足那条文案补上同一句「没有枚举、文件仍在 <workdir>」：这条路径写进库的 `left_on_remote` 是空数组，而空数组在面板上读起来就是「远端什么都没剩」。
4. `remoteWorkdir` 提到闸之前（它只是 `job.remote_workdir ?? 默认`，无副作用），让两条跳过文案都能指名文件在哪。
5. `buildAndBroadcastNotification` 挪到 `finalizeAndReturn` **之前**，并在声明旁写清为什么不能靠后（第二节那件事），防回退。

`src/main/compute/harvest-engine.test.ts`：新增 `harvestJob — disk headroom guard` 三条——低于阈值（跳下载、文案指名 workdir 与「未枚举」、零次 SSH、通知照发）、卷读不出来（同上，且 `harvestedAt` / `notifiedAt` 都写了）、读数达标（正常收割，无 `harvestError`）。

## 四 门禁（本机实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/main/compute/harvest-engine.test.ts --maxWorkers=1` | **19 passed** |
| `npx vitest run src/main/compute --maxWorkers=2` | **28 files / 577 passed \| 5 skipped（582）**，exit 0 |
| `npx tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `npx tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `npx eslint --no-cache`（本笔两文件） | 0 problems |
| `npx prettier --check`（本笔两文件） | 通过 |

## 五 边界与具名未办

1. **没有窗口读数**：本笔只到 `harvestJob` 写进作业行的那几个字段这一层。面板文案没有改，`FeaturedOutputs` 照旧把 `harvest_error` 与 workdir 显示出来，因此不声称界面外观有任何变化。
2. **`left_on_remote` 仍然无法表达「未知」**：跳过路径写的是空数组，`left_on_remote_count = 0`，面板不会出现「N 个留在远端」那一行；真相只在那句 `harvest_error` 里。要让结构化字段自己说「没枚举」，需要动 `ComputeDonePayload` 的形状 + 面板 + 九语字典，属独立单元，本笔不掺。
3. **闸仍然读整个数据根所在的卷**，不是每个项目各自的配额——这与参考实现同口径，未改。

# 2026-10-25 执行器一轮：三道红同一个成因（启动归属清单）+ 隧道「无声收尾」缺口

> 这一份是**独立档**，没有并进 `docs/plan-2026-10-03-next-queue-and-round-convention.md`：
> 那一份当时正被桌面会话线连续提交（22:14→00:17 之间十笔），并进去的窗口只有几秒，
> 撞上就是白写一节。下一轮请把结论当作那一份的延续读。

## 一 开工核对

- 开工时 `HEAD = origin/main = 6c7d99a1`，上一轮留下的两个在制文件就是本轮第一笔
  （`src/main/net/egress-proxy.ts` / `egress.test.ts`）。
- 队列 B 段（A7 / S3 / M2）接续上一轮的结论：A7 ✅、S3 ✅（含 S4 读数）、M2 ⛔ 卡产品决定
  ⇒ 按约定取自拟单元，优先取「主干上的红」。
- 桌面会话线在本轮期间**一直在推**（22:14 起 `bf176437`…`88c1b080`），并发纪律：只碰自己那几个路径，
  推送前现查在飞车道。

## 二 主干三道红，同一个成因

| 车道 | run | 提交 | 失败处 | 读数 |
|---|---|---|---|---|
| Nightly `build / Verify` | 40107474986 | `24f6281b` | Step 7 `Test (with coverage)` | `ipc-startup-attribution.test.ts:28` `expected …(11) to deeply equal …(10)`，多出的名字是 `load-probe-answers` |
| `Windows Full Test (8/8)` | 40107474911 | `24f6281b` | 同一条用例 | `1 failed \| 1565 passed \| 12 skipped (1578)` |
| Release v2.17.6 `build / Verify` | 40109691162 | `24f6281b` | Step 7 `Test (with coverage)` | 下游 `build / Build`、`publish`、`notarize-mac` **全 skipped** |
| Release v2.17.4 `build / Verify` | 40105384598 | `b43f63dc` | 同上 | 同一形状 |

**成因**：`bf176437`（探测答案跨进程复用，22:14）在 `src/main/ipc.ts` 加了第 12 个被计时的装配阶段
`await composeSteps.step('load-probe-answers', …)`，而那张「必须逐个点名、按装配顺序」的清单没跟着改。
它是**生产代码里的一份清单副本**，所以三条车道一起红，且都红在同一条用例上。

**这条红的代价不是一次 CI 失败，而是连着三版没发全资产**：

| 版本 | 页上资产数 | 说明 |
|---|---|---|
| v2.17.0 | **21** | 引脚红之前 |
| v2.17.1 | 3 | 另一成因（`readme-connector-count`，85 vs 282）：移动 tag 后 Verify 转绿，但 `macos-arm64` 停在 P0 认证步骤 ⇒ `publish` 同样没跑（上一轮记录） |
| v2.17.2 | **21** | 救回后 |
| v2.17.4 | 3 | 本成因 |
| v2.17.5 | 3 | 本成因 |
| v2.17.6 | 3 | 本成因（Release run 40109691162 于 00:18:21 结束为 failure） |

页上那 3 个（`version.json` + mac-arm64 `dmg` + `blockmap`）是**本地补传**的；四平台那 19–21 个
走的是 Release 的 `publish` 作业，而 `publish` 只在 Verify 绿时才跑。

**改法**：把新阶段按真实装配顺序补进清单（`settings-service` 之后、`read-stored-settings` 之前），
并写明它为什么必须落在被计时的窗口里（preflight 走的就是它恢复的答案：`opencode --version`
冷跑 4,035.9 ms vs 命中文件 1.062 ms）。

**「这一个引脚就是全部原因」的硬读数**：v2.17.6 Release 的 `build / Verify` 作业日志（job
120918663520）末尾 —

```
Test Files  1 failed | 1384 passed | 18 skipped (1403)
     Tests  1 failed | 17582 passed | 213 skipped (17796)
```

唯一那条失败就是本节的引脚。也就是说 `publish` 被它一条挡下，而那一版页上本该有 19–21 个资产。

**边界**：本笔只让那条用例转绿；「下一版真的回到 21 个资产」要等**下一次 tag 驱动的 Release**
才有读数，本轮**不能**声称发布链已修好。

## 三 隧道：客户端「无声消失」时到目标的连接没人收尾

上一笔（`053760cd`）把收尾收敛成单一 `teardown()`，但只挂了 `socket.on('error')` 与
`connection.on('close')`。客户端 `destroy()` 在没有待写数据时**只发 close、不发 error**；
内核把一次 reset 报成 close 时也一样 ⇒ `teardown()` 从不执行，到目标的连接被留着 ——
正是这条隧道存在的目的没兜住的那一半。

本笔：`socket.on('close', () => teardown())`，`settled` 保证与 error 路径幂等。

**A/B 读数**（本机，同一棵树背靠背，各 5 次，只跑「客户端终结」那两条用例）：

| 臂 | 结果 |
|---|---|
| 带修复 | **5/5 通过** |
| 去掉那一行（其余字节不变，事后逐字节还原、sha256 与改前相同） | **4/5**，唯一失败的是 `tears an established tunnel down when the client is **reset**d`，行是 `AssertionError: expected 'timeout' to be 'closed'` |

⇒ 2026-10-24 Release `build / Verify` 那条红（同名 + 同断言）可归到这一个触发点上：
在这台机器上 reset 有一半概率只呈现为 close。

新增一条**不依赖时序**的用例：用测试自己拥有的 `Duplex` 驱动 connect 处理器，只发 close、
不发 error/end。变异自证：去掉那一行 ⇒ 该用例恰红（`1 failed | 30 skipped`）。

## 四 门禁（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| `src/main/net` 整域 | **8 files / 92 passed** |
| `egress.test.ts` 连跑 3 遍 | **31/31 × 3** |
| 变异（去掉 close 收尾） | `1 failed \| 30 skipped`（恰是新用例） |
| `ipc-startup-attribution.test.ts` | **5 passed** |
| 双 typecheck（`--composite false`） | node **0**、web **0** |
| `eslint --no-cache`（4 个改动文件） | **0** |
| `scripts/pre-push-checks.sh` | ✓ |

## 五 边界（不许读成更强）

1. **发布链是否真回到 21 个资产，本轮没有读数**：要等下一次 tag 驱动的 Release。
2. **那条 reset 用例的机制只定到「close 也要收尾」这一层**：本机 A/B 与变异都把红复现到了
   这一个触发点，但没有解释「为什么这台机器上 reset 有时不产生 error」——那属于内核/Node 版本行为，
   本轮不追。具名留着，不写成已查清。
3. `docs/plan-2026-10-03-…` 那份共享台账本轮**一个字没动**（会话线在连续提交它）；
   本档就是这一轮的台账。

# 护栏真机验证：两个新通道 + 摘要会话的保存被拒（并用它抓到一个真缺陷）

- 日期：2026-09-18
- 实例：**带窗口的真机实例**（`electron-vite dev --remote-debugging-port=9333`，Playwright `connectOverCDP` 驱动真实窗口，真实鼠标事件）
- 语料：**真实数据根的副本**（`/tmp/ps-bench-cold`；真实根从未被指向、从未被写）
- 入口：全部走**用户真实路径** —— 首页「最近的会话」行 → 工作区侧栏 → 会话操作菜单 → Pin
- 判据：`摘要会话的编辑必须落不到盘上；读到文档之后同一次编辑必须落到盘上`

## 一、两个新通道（真机 web RPC）

（读数采自同一批真机运行：索引单元 `c16c1dd` 的实例上量得延时与载荷；护栏修复只改渲染层 store，不触及这两个通道的实现。）

| 调用 | 返回体量 | 耗时 |
|---|---|---|
| `sessions:list-catalog` | **569,858 B（0.54 MB，59 会话）** | **68.2 ms**（冷启动第一次）/ 稳态 p95 **23.2 ms** |
| `sessions:read-document`（单会话 116 条消息） | 2,336,655 B | **64.0 ms** |

同一会话在两个通道上的分工（真机读数）：列表条目**没有 `messages`** 但 `messageCount = 116`；`read-document` 取回 116 条消息 + `conversationGraph`。

## 二、护栏真路径 —— **第一次跑出的是缺陷，不是绿灯**

第一轮（修复前，`c16c1dd` 之后、护栏修复之前）驱动真实窗口：

| 步骤 | 目标会话文件 | 结论 |
|---|---|---|
| Pin 一个**没打开过**的会话（store 里只有摘要） | **9 条消息的文档被改写成 `messages: 0`（graph 也是 0）**：323,416 → 4,175 B | ❌ **静默截断，护栏没拦住** |
| 再打开它、再 Pin | 文件变成 `pinned: true`、`messages: 0` | ❌ 数据已丢 |

**根因（代码级定案）**：护栏把「仅摘要」标记放在 `WeakSet<ChatSession>` 里，**按对象身份**记；而 store 的每一次更新都会**换新对象**（`togglePinned` 就是 `{ ...session, pinned: !session.pinned }`）。于是**第一次不可变编辑就把标记丢了**，saver 随后看到一个「没有标记、messages 为空」的会话，就把摘要写进了文档 —— 正是护栏存在的理由。

**修法**：标记改为**按 session id**（`Set<string>`），并在三条真实路径上显式解除：读到文档（`applySessionDocument`）、main 推来带内容的投影（`applyDurableSessionProjection`）、store 重置（`createInitialSessionState`，否则残留 id 会让后来新建的同 id 会话被静默拒写）。

**回归测试**（本次新增两条，正是能抓住它的人造用例）：`keeps the guard through an edit that replaces the summary object`（编辑换对象后仍拒写）、`lifts the guard when the document arrives, so the same edit then persists`（读到文档后同一编辑放行）。

## 三、修复后的复验（同一真机路径，同一操作）

| 步骤 | 文件字节 | sha256(前 12) | pinned | 判定 |
|---|---|---|---|---|
| Pin 前（B 只有摘要） | 323,416 | `2c56e0767907` | false | — |
| **Pin 之后（摘要态）** | **323,416** | **`2c56e0767907`** | false | ✅ **完全未变 ⇒ 保存被拒** |
| 打开 B（document 读回）后再 Pin | 322,895 | `186bd84e1e12` | **true** | ✅ **写入生效** |

**写后完整性核对**（防止「拒绝失败但不报错」这类假绿）：该文档仍是 **9 条消息**（扁平列表与 `conversationGraph` 都是 9），`pinned: true`，索引 v2 同步为 `messageCount 9 / pinned true`，列表预览仍是原文（`Acknowledged — all five IDs are genuine PDB entries…`）。即：**拒写时确实没写；放行时写的是完整文档**。

## 四、诚实边界

1. 本轮数字来自 **dev 构建**（窗口实例）；打包版未复测。
2. 语料是**副本**：真实根（`~/.purescience-project`）未被指向；上面那次截断只发生在副本里，真实数据完好（副本重建后目标会话仍是 9 条消息，可查）。
3. **一次 UI 级 A/B**：同一条用户路径、同一个动作，修复前截断、修复后拒写 —— 这不是统计量，是行为开关；没有多次重复的说法。
4. 未量：打包版窗口、以及除 Pin 之外的其他编辑路径（rename/archive）是否也走同一 saver —— 它们走的是同一个 saver 条件，但**没有逐条真机取证**，不宣称。
5. 修复后的头两个通道数字（第一节）取自修复前的进程；护栏修复只改渲染层 store，不触及这两个通道的实现（这两个通道在修复前后都实测过：`68.2 / 64.0 ms`，`0.54 MB`）。

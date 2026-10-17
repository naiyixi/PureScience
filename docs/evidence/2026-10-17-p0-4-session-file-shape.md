# P0-4 第二半：会话文件只存一份对话（2026-10-17）

> 单元：`按内容增量写` 的第一刀 —— 先把**同一段对话被写三遍**这件事量清、再从存储形状上拿掉。
> 前一半（慢保存归因：`queuedMs` / `writeMs` / `authorityMs` / `aftermathMs` 分段）见
> `docs/evidence/2026-10-17-p0-4-slow-save-phases.md`；那一半的结论是**钱在 1 MB 级整份读写**，不在排队。

## 一 怎么量的

- 对象：**真实配置根**（`~/.purescience-project/sessions/`）里的 65 个会话文件，**只读**，一个字节都没写。
- 工具：应用**自己的读写器**（`normalizeSessionFile` 读、`createSessionFile` 写），不自己拼 JSON。
  所有探针都是临时用例（跑完即删，未入库），统计写 `/tmp/probe-*.txt`。
- 两种口径：
  1. **字节口径**：磁盘上现有文件的大小 vs 用新写器重写后的大小（`JSON.stringify(doc, null, 2) + '\n'`，与仓内落盘写法一致）。
  2. **结构口径**：`读 → 新写器写 → 再读`，把结果与原始读入结果做**与键序无关**的深比较（先按 key 排序再序列化）。
     第一版探针用裸 `JSON.stringify` 比较，把「键的插入顺序不同」误报成 64 处差异 —— 那是仪器错，已改。
- 同一批文件还用**旧写器**（`sanitizeSessionMessageImages(materializeSessionConversationGraph(loaded))`）
  走了同一条往返，用来把「本次改动引入的差异」与「既有往返行为」分开。

## 二 读数

| 项 | 读数 |
| --- | --- |
| 可比文件 | 65（带 `conversationGraph` 的会话） |
| 磁盘现有字节 | 68,988,647 |
| 新写器写出的字节 | 36,405,175 |
| **字节比** | **0.528**（同一批会话，本机真实数据根） |
| 往返结构相同 | **64 / 65** |
| 旧写器往返漂移 | 0 / 65 |
| 新写器往返漂移 | 1 / 65（`de70d881…`：4 条活动的 `toolContent` 由 `undefined` 变有值 —— **图那边更全**，不是丢数据） |

文件构成（同一批文件上量的三份副本占字节的比例）：`conversationGraph` **51%**、顶层 `activities` **33%**、
顶层 `messages` **16%** —— 也就是说同一段对话在磁盘上被写了三遍。CPU 侧不是瓶颈：最大那个 3.1 MB 文件
`JSON.parse` 7.4 ms、缩进序列化 4.9 ms，紧凑序列化只再省 11% ⇒ **钱在字节数与 IO**。

顶点一致性（改形状之前先证「被丢的那两份确实能从图重建」）：

- 图的活动并集投影（剥掉 `agentFrameId` / `messageBranchId` / `runtimeSegmentId` 三个归属字段）与存储的顶层
  `activities` 在 **64 / 65** 个文件上逐字节相同；唯一不同的是上面那个 `toolContent` 文件（`stored=95 union=95`，
  id 集合无差，只有内容字段）。
- `messages` 与 `activityGroups` **65 / 65** 相同。

## 三 改动

| 文件 | 改动 |
| --- | --- |
| `src/shared/conversation-graph.ts` | 新增 `projectPersistedConversationActivities()`：把图里的活动/分组按分支作用域剥字段投回顶层形状，**保留 `promptMessageId`**（文档记录的是「这条活动回答哪一句提问」）。 |
| `src/shared/session-persistence.ts` | ① 读：图存在且**原文档缺数组**时从图重建 `activities` / `activityGroups`（数组在位则以原位为准 ⇒ 老文件行为逐字不变）；② 写：`createSessionFile` 不再写 `messages`（读侧恒从图重建）、也不再写那两个数组，**但只在该投影确实被图完整复现时才丢**（按 id 判据；图里放不下的活动仍原样留在文档里，绝不静默抹掉）；③ `SESSION_FILE_VERSION` 2 → 3，并新增 `PersistedSessionFileBody` 让「可省略的三份投影」在类型上成立；④ 同批修掉一处**既有**缺陷：`resumeRecovery`（中断回合记录）写侧有、读侧从未复制 ⇒ 会话在第一次重存后（状态已是 `error`，不再走「中断派生」那条路）第二次启动就读不回来了（真机 65 个会话里 **2 个**是这种形状，**旧写器同样会丢**）。修法是按写侧同一条判据恢复：只有 `status=error`、记录合法、且它点名的回合**至今仍无已完成答复**时保留。 |

## 四 边界与具名未办

1. **0.528 是本机真实数据根上的字节比，不是 `writeMs` 的读数。** 真机上 `writeMs` 的中位 / p90 是否落进
   一半以内，要等这一版装机后取，判据见 `docs/evidence/2026-10-17-p0-4-slow-save-phases.md` §四。
   P0-4 本轮**没有修好流畅度**，只把「能省的 47% 重复字节」这条路量清并做进产品。
2. **降级方向具名**：文件版本号抬到 3，但读侧**不校验版本**。旧版本读新文件时 `messages` 会从图重建
   （旧代码本来就带这条），而 `activities` / `activityGroups` 不会被重建 ⇒ 旧版本上工具活动面板会空。
   这是**升版后回退到旧版**时的已知降级，不是前向兼容问题（新读老文件有专门用例）。
3. **活动里图更全的那一处（1/65）**：`toolContent` 在图上存在、在旧顶层数组里缺失。写侧丢数组后，
   读回来的活动**多**了 4 条内容 ⇒ 方向是「更完整」，但严格说这仍是一次「往返不等」，
   已在探针读数里逐字记下文件名。
4. 未做：消息级增量追加（真正的「按内容增量写」）。本单元只做了「不再重复存三份」。

## 五 怎么复跑

探针是临时用例（读了真实数据根、只读），配方：读 `~/.purescience-project/sessions/<projectId>/*.json` →
`normalizeSessionFile(JSON.parse(raw))` → `createSessionFile(loaded)` → 比较 `JSON.stringify(doc, null, 2)+'\n'`
的字节数与「再读一次的结果」；比较必须**按 key 排序**否则键序会伪装成差异。仓内可复跑的守卫是同批新增的
`src/shared/session-persistence.test.ts` 里 `single-copy conversation storage` 两条（存一份 / 图放不下的活动不许丢）
与 `resumeRecovery` 的两条（能恢复 / 点名的回合已答则丢弃）。

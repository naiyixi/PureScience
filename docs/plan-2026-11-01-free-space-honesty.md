## 执行器本轮追加（2026-11-01 03:1x–）—— 「读不到可用空间」不再印成 0 B：一次缺席被当成一次测量

> 为什么单独一份：共享台账 `docs/plan-2026-10-03-next-queue-and-round-convention.md` 的末尾还躺着**并行会话未提交的 §268**，
> 整路径提交会把它的在制文本卷进这一笔 ⇒ 本轮结论落在这里（新路径），等它那节落定后可由下一轮并回台账。

### 〇 开工核对（防重做 + 并发 + 该谁做）

- `git fetch` 后 `origin/main = fbc84dbc`，本地与远端同点、`git log origin/main..HEAD` 为空；两条主干车道在该 SHA 上
  **Nightly = success、Windows Full Test = success**（`gh run list` 现查，另有 `78f72ceb` 那笔的 Windows 车道为 failure——那笔已由
  §268 §五 2 记账为「红且已被更正」，不引它的读数）。
- 工作树三份**并行会话**在制件：`docs/plan-2026-10-03-…`（§268 未提交）、`docs/plan-2026-10-28-two-releases.md`（H1/H2 两行）、
  `src/main/references/screening-service.ts`（+19 行 logger 注入，当前带 4 条 TS 错）—— **一个字节没碰**。
- 队列 B 段（A7 ✅ / S3 ✅ / M2 ⛔ 卡产品决定）仍耗尽；A 段无 ≥3 天无人动项 ⇒ 自拟单元。
- 上一轮 §268 §五 的开项复核：① tag ↔ 认证件的 6 文件差额要一次「无在飞车道 + 允许一条 tag 触发的 Release 重跑」的窗口，本轮不动；
  ② v2.21.0 已发布（21 资产、Latest），③ 「A 组发布件读数」仍被网络与空闲物理页挡着，取不到就不假装取到。

### 一 单元从哪来：先读真机日志，再只查被点到的那一处

`~/Library/Logs/PureScience/main.log`（2,352 行，`2026-10-29T14:42Z → 10-31T15:52Z`）按 `level|scope|msg` 聚合后，
除了已知的慢通道，有一条真实能力在**失败**：

```
3  warn  storage:ipc  available storage lookup failed            data: { errorCategory: "not-found" }
1  warn  storage:ipc  storage info was slow                      totalMs 232425 / availableMs 232042 / heldMs 231945 / attribution no-cpu-in-process
```

**先量再改的两步**：① 读源码定位 —— `availableBytes()` 只是一次 `statfs(dataRoot)`，`ENOENT/ENOTDIR` 被
`diagnosticErrorFields` 归类成 `not-found`；② 读失败之后的**去向** —— `command-owner.ts` 的 `getInfo()` 里初值是
`let available = 0`，catch 只写一行日志，随后把 `availableBytes: 0` 原样交给渲染层，而 `StoragePanel` 直接
`formatBytes(info.availableBytes)` ⇒ 面板上的「Available on disk」印 **`0 B`**，与「磁盘满了」**逐字同形**。
一次没有发生的测量被当成一次测量，正是本仓反复立过的「缺席 ≠ 没有」。

**边界（不许读成更强）**：那条 232 s 的同一次 runId 里，`update-check` 也用了 233.7 s 失败（`errorCategory: request`），
两者同时结束 ⇒ 本机分不清「statfs 自己卡住」与「整机那段时间被挂起」。所以本轮**不声称修好了 232 秒**，
只修「失败被印成 0」这一半；232 s 的归因留作具名开项。

### 二 交付（三个产品文件 + 九语一条键 + 两支用例）

| 位置                                                         | 改动                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/storage.ts`                                      | `availableBytes: number` → `number \| null`，头注写明 **null 不是 0**：0 是「磁盘满了」的断言，null 是「没读到」                   |
| `src/main/storage/command-owner.ts`                          | 初值改 `null`、失败保持 `null`（日志照旧具名），头注写明「新鲜安装的默认根还没建出来也会走到这一支」                               |
| `src/renderer/src/pages/settings/StoragePanel.tsx`           | 两态渲染：`null` → `settings.availableOnDiskUnreadable`，有值 → `formatBytes(...)`；行上补 `data-testid="storage-available-bytes"` |
| `src/renderer/src/i18n/{en,zh,zh-Hant,ja,ko,de,fr,es,ru}.ts` | 新增一条键（九语齐平，zh ≠ en，zh-Hant 用繁体）：`Could not read free space` / `无法读取可用空间` / …                              |
| `src/main/storage/ipc.test.ts`                               | 「不存在的根 ⇒ `availableBytes` 为 **null**（不是 0），其余读数照常返回、失败仍进日志」                                            |
| `StoragePanel.render.test.tsx`                               | 两支成对：「null ⇒ 屏上写『读不到』且不含 `0 B`」/「有值 ⇒ 印数字」，防这条分支烂成永远说读不到                                    |

**变异自证（本机实跑，改完即还原）**：
把 `command-owner.ts` 的初值改回 `0` ⇒ 主进程那条用例 **`expected +0 to be null`** 当场红；
把面板的三态判断改成 `false &&`（即恒走 `formatBytes(0)`）⇒ 渲染那条用例红。两条都只在被测行为被撤掉时红。

### 三 门禁（全部实跑；数字取自最后一次改动之后）

| 环                                                                                                                      | 读数                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定向：`src/main/storage` + `src/renderer/src/pages/settings` + `host-application-commands.test.ts` + `pages/onboarding` | **93 文件 / 1101 passed, 1 skipped**                                                                                                                                                                                                |
| `src/renderer/src/i18n`（含 `translation-quality`）+ StoragePanel 渲染                                                  | **5 文件 / 85 passed**                                                                                                                                                                                                              |
| 双 typecheck（`--composite false`）                                                                                     | 本笔 0 错；全仓余 4 条**全在并行会话在制的 `screening-service.ts`**（`TS6133`×3 / `TS2564`×1），与本节无关，未去改                                                                                                                  |
| `eslint --no-cache`（本笔 5 个源/测试文件）                                                                             | **0 error**                                                                                                                                                                                                                         |
| `prettier --check`                                                                                                      | 本笔 5 个文件过；**九份 i18n 字典在本笔之前就不是 prettier-clean**（实测 `--check` 在未改动的 `en.ts`/`zh.ts` 上已报 warn）⇒ 只按局部风格插入一行，**没有**顺手 `--write`（那会把 gallery 一批长行一起改写，制造与本次无关的 hunk） |

### 四 边界与具名未办

1. **没有窗口读数**：本轮是「契约改成两态 + 两条成对用例」，真机面（面板那一行）**未取词**。要取的话需要一次真窗口
   打开 Storage 面板并让 `statfs` 失败（可把数据根设到一个已删目录），本机当前没有空闲实例可安全驱动，不冒充已取。
2. **232 秒那一半没修，但已定因到「机器侧」**（本轮补齐读数）：同一次爆发里**六个通道在 0.7 秒内先后结束**
   ——`settings:encryption-available` 231.8 s、`sessions:list-catalog` 232.2 s、`network:check-connectivity` 232.6 s、
   `settings:get-settings` 232.4 s、`settings:get-preflight` 232.4 s、`storage:get-info` 232.4 s（全部 `no-cpu-in-process`）
   ⇒ 不是 `statfs` 自己卡住，而是整机在那 232 s 里一起停住（典型的挂起/深睡）。同一份日志里 10-29 16:16–17:50 连续出现
   100–250 s 的同类间隔，形态一致。**因此本轮只修「失败被印成 0」，不声称修好了那 232 秒**；若要真收，
   需要一条与本次不同的判据（例如同刻两个独立调用是否同时结束），而不是加大超时。
3. **`availableBytes` 的其它读者**：全仓只有 `StoragePanel` 一处渲染（另有 5 处测试夹具给的是真实数字），web 面无读者 ⇒ 类型放宽不牵动通道与计数 pin。
4. **并回台账**：等并行会话提交它的 §268 之后，下一轮把本节并入 `docs/plan-2026-10-03-…` 的末尾（本轮不碰它的在制文本）。

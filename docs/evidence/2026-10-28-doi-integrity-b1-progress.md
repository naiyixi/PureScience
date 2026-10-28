# B1 文献完整性检查：已完成的两步与剩下的接线

日期：2026-10-28
状态：**检查器与落库已完成并有门禁读数；IPC 与导出闸门尚未开始。**

## 一 已完成

### 1 检查器 `src/main/references/doi-integrity.ts`（`487685f9`）

- 两个方向都读：`relation.is-retracted-by / is-corrected-by / is-expression-of-concern-for`（本文被撤/被更正），
  与 `update-to` 的 `retraction / correction / erratum / withdrawal`（本文是通知）；
- 严重度：`retracted > expression-of-concern > corrected > clean`；
- 每条结论带 `sourceUrl`（具体 Crossref 记录）+ `checkedAt` + `notices[].doi/url`，读者可点回原记录；
- **诚实边界**：HTTP 非 2xx、无 `message`、网络异常、空 DOI 一律 `unavailable`，**绝不读成 `clean`**。
- 用例 9 例（两方向记录、严重度排序、四类 unavailable、空 DOI 不打网络）。

### 2 落库（`48b4375f`）

- `Reference` 新增 `integrityStatus` / `integrityCheckedAt` / `integritySourceUrl` / `integrityNoticesJson`；
- `ReferenceRepository.recordDoiIntegrity` / `getDoiIntegrity`：三者同写；`unavailable` 也落库；
  未检查过返回 `undefined`（与「检查过且干净」区分）；复查覆盖旧值。
- 用例 3 例（往返、unavailable 语义、覆盖）。
- 踩过的坑：`column()` 迁移步骤若排在 `REFERENCE_TABLE_DDL` 之前，新库建表前 ALTER 会被跳过；
  正确做法是同时补规范 DDL 并把步骤移到建表之后。

## 二 剩下的接线（下一步，按顺序）

1. **`references:check-integrity` 应用命令**
   - 在 `src/main/references/application-commands.ts` 的组里加
     `defineApplicationCommand<'references:check-integrity', readonly [projectId: string], Result>('references:check-integrity')`；
   - 在 `ReferencesCommandOwner` 上补同名方法（现有模式：`dependencies.references.<method>(...args)`）；
   - 在 `src/main/references/ipc.ts` 注册 `ipcMainHandle('references:check-integrity', …)`，
     并让 web-service 对等面走同一个 application command（本仓要求三端同源）。
2. **实现**：列出项目里带 DOI 的引用 → 逐条 `checkDoiIntegrity({ fetchImpl })` → `recordDoiIntegrity` →
   返回汇总 `{ checked, retracted, corrected, concerns, unavailable, notices }`。
   注意 `unavailable` 要在汇总里单列，不能并入 `clean`。
3. **导出闸门**：在生成报告/文献表前调用一个纯函数
   `collectIntegrityGaps(references, { maxAgeDays })`，返回「带 DOI 但未检查 / 检查为 unavailable /
   检查过期」的条目；非空即拒绝导出并把这三类**点名列出**。这是与对标「只给提示」的差异化点。
4. 用例：命令层（真实 DB + stub fetch）、闸门纯函数（三类 gap 各一例 + 全通过一例）。

## 二·五 导出闸门的落点已定位（2026-10-28 补）

本仓没有独立的 reports 模块，导出发生在**渲染层的筛选面板引用导出**：

- `src/renderer/src/components/references/screening-export-citations.ts` —— 组装导出内容，且已经用
  `ScreeningExportCitationGap { referenceId, title, reason: 'file-not-in-index' | 'read-failed' }`
  这套「读不到就具名报告」的模式；
- `src/renderer/src/components/references/ReferencesScreeningPanel.tsx` —— 调它的面板；
- 渲染层测试已存在（`ReferencesScreeningPanel.render.test.tsx`）。

所以闸门应当长在**这里**，复用同一套 gaps 表达。

**先修正一处设计错误**：导出时**不能**调用 `check-integrity`——那会同步逐条查 Crossref（公共接口、无 key、
有限流），把一次点击变成几十次网络往返。导出只该读**已存的判定**。因此闸门需要一个只读摘要命令，
联网的 `check-integrity` 保持为显式的「现在检查」动作：

- 新增 `ReferenceRepository.summarizeIntegrity(projectId)`：返回 `{ retracted: [...], gaps: [...] }`，
  全部来自库里的 `integrity*` 列，零网络；
- 新增命令 `references:read-integrity-summary`（与 `check-integrity` 并列，三端同源）。

1. 导出前调用 `references:read-integrity-summary` 拿到 `retracted` 与三类 `gaps`；
2. `retracted` 的条目在导出范围内 ⇒ **拒绝导出**并点名（附 doi.org 链接与检查时间）；
3. `never-checked / unavailable / stale` ⇒ 允许导出但把三类缺口**逐条列在导出物里**
   （理由：这三类要的动作不同，静默放行等于让「没查过」冒充「查过没问题」）；
4. 面板测试补两例：有 retracted 时拒绝、只有未检查时导出并列出缺口。

## 二·六 面板接线的完整清单（7 处，下次照做）

主进程侧已全部就绪（`be950e65`）：`references:read-integrity-summary` 三端同源。渲染层还差七处：

| #   | 文件                                                              | 改什么                                                                                           |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | `src/preload/index.ts`（≈730 行，`fetchByIdentifier` 旁）         | 加 `readIntegritySummary: (projectId) => invoke('references.read-integrity-summary', projectId)` |
| 2   | `src/preload/renderer-api.d.ts`（≈1072 行）                       | 加同名方法与返回类型（retracted / gaps / checked / total）                                       |
| 3   | `src/preload/index.test.ts`（≈440 行的频道清单）                  | 清单加 `'references.read-integrity-summary'`                                                     |
| 4   | `ReferencesScreeningPanel.tsx`（`handleExportIncluded`，≈664 行） | 导出前调 1 的命令；`retracted` 与导出范围有交集 ⇒ `onError(...)` 并 return                       |
| 5   | 同上                                                              | 否则把三类 `gaps` 并入导出文本块（与标注证据块同级、同风格）                                     |
| 6   | i18n（`references.screening.export.*` 邻近）                      | 三条文案：拒绝（点名 + doi.org + 检查时间）、缺口表头、三类缺口各行                              |
| 7   | `ReferencesScreeningPanel.render.test.tsx`                        | 两例：有 retracted 时拒绝且不写文件；只有 never-checked 时导出并列出缺口                         |

**判定口径**：`retracted` ⇒ 拒绝（决定）；三类 `gaps` ⇒ 照常导出但逐条写明（指令）。
不把两者混为一谈，也不静默放行——「没查过」不能冒充「查过没问题」。

## 二·七 一次失败尝试的读数：渲染层不是「加一行」，改的是契约目录

我按清单第 1–3 项动手（preload 实现 + 类型 + 频道清单），结果 **7 条清单测试当场红**，`npm run typecheck`
还以 **134** 退出（V8 堆上限，不是类型错误）：

| 现象                                                                                  | 真因                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `preload/index.test.ts`「pins every callable path」红                                 | 新增可调用路径必须同步 `src/shared/renderer-contract-catalog.ts`（渲染层能力的**单一来源**），不是只改 preload |
| `renderer-contract-catalog.test.ts`「pins the complete capability-owned inventory」红 | 目录里有分组与 profile 语义，新命令要归到 `references` 组并指定 profile                                        |
| `npm run check:web-api-map` 起初通过但映射表里没有新频道                              | 映射表由 `scripts/generate-web-api-map.mjs` **从契约目录生成**；目录没登记就不会出现                           |
| `npm run typecheck` exit 134                                                          | 需要 `NODE_OPTIONS=--max-old-space-size=8192`（与 `npm run build` 同）                                         |

**处置**：把这四处改动整批回滚（`git checkout --`），回到干净树并复测 —— preload+shared **148 文件 1690 例**
全绿。宁可留在「后端全通、界面待接」，也不留 7 条红测试。

**给下一次的准确结论**：渲染层接线的最小改动面是
① `renderer-contract-catalog.ts`（登记 + 组 + profile）→ ② `npm run gen:web-api-map` → ③ preload 实现与类型
→ ④ 两处清单测试的期望值 → ⑤ 面板调用与 i18n → ⑥ 渲染测试。
即 **6 组，其中 3 组是清单期望值**；先跑 `check:web-api-map` 与两条 inventory 用例再动面板。

## 三 口径提醒

- 不做「检查失败就当干净」；`unavailable` 必须一路显式到 UI 与导出结论里；
- 不做「批量静默重试」掩盖失败；失败要能点名到具体 DOI 与原因；
- 导出闸门的拒绝文案必须给出**怎么修**（哪个 DOI 需要重查），否则用户只会绕过去。

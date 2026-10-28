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

## 三 口径提醒

- 不做「检查失败就当干净」；`unavailable` 必须一路显式到 UI 与导出结论里；
- 不做「批量静默重试」掩盖失败；失败要能点名到具体 DOI 与原因；
- 导出闸门的拒绝文案必须给出**怎么修**（哪个 DOI 需要重查），否则用户只会绕过去。

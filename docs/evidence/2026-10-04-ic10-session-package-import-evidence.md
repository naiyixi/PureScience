# IC10 会话包随包证据落库 —— 真机证据（2026-10-04）

## 缺口是什么

包的**导出**侧一直把四份必需证据写全（会话文档 + `evidence/citations.json` +
`evidence/review-findings.json` + `evidence/verifications.json`），而**导入**侧只读
`{ only: ['conversation.json'] }`（`session-package/import-session.ts`）⇒ 包到本机只剩会话文档，
引用、复核、人工附证全丢，而读者看到的却是「导入成功」。这就是本仓口径里的「一半的能力」：
导入后接收方的库里**没有任何一行**是这条会话带来的。

落地实现见提交 `04761221`（`session-package/import-evidence.ts`，7 个具名跳过码、永不抛错、
发送方本机指针一律不携带、人工附证指纹在本机对导入转录**重新派生**）。

## 一、真机读数（真包 → 跨项目导入 → 读接收方自己的表）

`e2e/certification/session-package-import-evidence.spec.ts`，本机真窗口（Electron + Playwright），
**1 passed (16.2s)**：

```
[ic10] source: citations=1 reviews=error/null:0|error/null:0 findings=0 pins=1
[ic10] landed: {"citations":1,"reviews":2,"reviewFindings":0,"verificationRecords":1,"skipped":[]}
[ic10] target citations: ["Molecular docking of nirmatrelvir"]
[ic10] target reviews: error/null:0|error/null:0
[ic10] target pins: [{"schemaVersion":1,"id":"427e5387-…","reviewId":"cmut71elq0006wfp9p148gdwy",
  "projectId":"cmut71ekc0004wfp9lstdjo3y","sessionId":"ed20ace2-…","messageId":"message-1791080420507-2",
  "role":"agent","fingerprint":"sha256:892d0f23f8216fa4497d4b1da3215f787ec21945e870f9dabbfdd0e633db146c",
  "query":"docking","terms":["docking"],"snippet":"Deterministic reply: Summarize the deterministic fixture.",
  "capturedAt":"2026-10-04T02:20:21.523Z"}]
1 passed (16.2s)
```

判据是**四个维度逐项与发送方自己的读数相等**（不是「至少一行」）：引用 1→1、复核 2→2、
人工附证 1→1、`skipped` 为空；接收方项目是**新建的空项目**，落地的每一行都只可能来自这个包。
最后一条钉子还带**本机可复算的指纹**（`sha256:892d0f23…`、`role: agent`）——不是复制发送方的指纹。

## 二、两条必须与读数一起读的诚实说明

1. **`reviewFindings` 两侧都是 0**：e2e 夹具的假 agent 不产出复核结论，两条复核行 `lifecycle` 都是
   `error`、`checks` 为空（日志里的 `error/null:0`）。即：**「复核行落地」有真机读数，
   「复核结论（checks）落地」只有单测覆盖**（`import-evidence.test.ts` 的 11 条用例），
   本机读数**没有**覆盖它，此处具名，不算作已实测。
2. **复核是 2 条不是 1 条**：应用自己在回合结束时会起一次 auto-review，加上 spec 手工 `reviewer.run`
   一次 ⇒ 发送方本来就是 2 条。所以断言写死 `1` 会把**正确的落地**读成失败（见 §三.2），
   改成「与发送方相等」既接受这一事实，也仍然能抓住重复/丢行。

## 三、这次真机跑出的两个 spec 缺陷（都不是产品缺陷，已改）

1. **第二个项目必须在项目列表页创建**：工作区一次只显示一个项目，会话开着时「New project」按钮
   根本不在该界面上 ⇒ 先点「All projects」回到项目列表（与 `electron-foundation.spec.ts` 同一写法），
   否则 `createProject` 等 30 s 超时。**这是交互层按设计如此**，不是按钮丢失。
2. **计数断言不许手写**：初版写 `expect(landed.reviews).toBe(1)`，
   真机读数 `reviews: 2` ⇒ 失败。手写数字有两个方向的错：写小了把正确落地读成红，
   写「恰好等于」又会放过接收方重复落行。改法=**先在发送方读一遍真源**（引用条数 / 复核行数 /
   复核 checks 总数 / 钉子数），导入后逐项与它比。这正是本仓「计数对到真源」的口径。

## 四、覆盖层级

| 层 | 证据 |
| --- | --- |
| 契约/引擎单测 | `import-evidence.test.ts`（11 条：逐字段校验、7 个具名跳过码、checks 落地、指纹重派生） |
| 接线 | `import-owner.test.ts` + `import-session.test.ts` + `ipc.ts` 端口透传 |
| 界面 | 导入对话框「已落库：引用 x · 复核 y · 审查结论 z · 验证 w」+ 逐条跳过原因（9 语 3 键） |
| **真机** | 本档 §一：真包、跨项目、接收方四张表逐项相等 + 本机可复算指纹 |

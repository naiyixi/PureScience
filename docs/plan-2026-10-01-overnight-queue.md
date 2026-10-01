# 过夜自主队列（v1.79.0 目标）— 2026-10-01 夜

由会话交接，供过夜自主执行使用。**每完成一项就提交 + 推送**；每项都必须"可提交、有证据、无半截"。
纪律（不可打折）：本地全绿（双 typecheck + eslint + 相关 vitest）→ `git commit`（常用 `HUSKY=0`）→ `git push origin main` → 看 CI 到结论。
**绝不把缺失的测量当成测量**；缺失即具名失败，绝不编造数值。**禁死代码**：新增能力必须同一提交内接到真实消费方。
真机/真文件级证据优先于单测；单测不算"功能已实机跑通"。

## 现状（开始时的事实）

- **v1.78.0「算筹」已发布**（tag `a4e7f352`，run `36887148887` success、21 资产、正文 8532、认证齐全、Latest）。
- 已完成：R3（每轮文件证据三态）、R6（内容寻址去重 + 自证空间报告 + 就地整理）、A2（K1a 收口）、A4、A6、A5（+70 个历史发布页重建）、
  A8（真机达成：装 `codex-acp` 后应用找到了 `ChatGPT.app` 内的 Codex 且 ACP 握手通过）、R4-U1（折行表头）、R4-U2（题注关联）。
- 适配器已在机器上：`/Users/totota/.local/bin/codex-acp`（撤销：`npm rm -g @zed-industries/codex-acp`）。

## 队列（按顺序；每项做完即提交）

### Q1. R4-U4「为什么不是表」的可读理由（编辑清单已写在 `docs/plan-2026-10-01-v1.78.0-slices.md` §4）
1. 抽 `measureTableShape(items, options)`：把 `groupRows → columnAnchors → placeInColumns → mergeSplitColumns → joinWrappedHeaderRows` 合成一处，
   返回 `{ rows, columns, spanningRows }`，**由抽取与理由共用**（两处各写一份必然会漂移，那时理由就是撒谎）。
2. 新增 `explainTableRejection(page, items, options)`：具名原因 `blank-page` / `too-few-rows` / `too-few-columns` / `rows-do-not-span-columns`
   ＋判定所用计数与下限。
3. 接进 `src/main/settings/pdf-service.ts`：**仅在整段扫描无候选时**附带 per-page 原因，随工具结果返回。
4. 测试：四个原因分支各一条 ＋「有候选时不出理由」；真机取一页纯散文与一页真表格对比（散文页给原因与计数、真表格页出候选且不带理由）。

### Q2. R4-U3 旋转与符号/连字修复
- 目标：旋转页面上的表被当成横排文本（列全乱）、连字（ﬁ/ﬂ）与软连字符切碎单元格词。
- 做法：先探现状（`src/shared/pdf-table-extraction.ts` 是否有旋转信息可用：`PdfTextItem` 无角度字段 ⇒ 需从 PDF 操作符取 `Tm/Td` 的旋转分量，
  或在 `src/main/settings/pdf-service.ts` 的解析层把旋转归一化）。**先写调查结论再动代码**（照 R6-U1 的先例）。
- 验收：真机取一个旋转 90° 的表格页与一个含 ﬁ/ﬂ 的页，读数前后对比。

### Q3. ①④⑤ 在真实 codex 回合路径上取证
- 现在适配器通了（`detectCodex()` 零参数即可复现：`adapterPath=~/.local/bin/codex-acp`、`nativeCodexPath=/Applications/ChatGPT.app/Contents/Resources/codex`、
  `nativeCodexVersion=0.154.0-alpha.6.2`，返回对象的前提是真实 ACP initialize 通过）。
- 取证方式：起隔离实例（`PURESCIENCE_STORAGE_ROOT=/tmp/<新名>`、`PURESCIENCE_WEB_PORT=<未用端口>`、`npm run dev:headless`），
  触发一次带技能选择的真实回合，读留痕（`FUNCTION_MODEL_EVENT_LOG_LIMIT=200`），记录：① 内置回落与具名原因 ④ 真实往返耗时与是否真选出技能 ⑤ 失败回落 `call-failed`。
- 纪律：**a missing measurement must never be reported as a measurement**；用量未报告就写 "not reported"，绝不写 0。

### Q4. R2 期刊实体（**依赖**：文献智能筛选计划的 S1 迁移）
- 若 S1 尚未落地：**不要单独动库**，保持 `docs/plan-2026-10-01-R2-journal-entity.md` 的设计与"共用一次迁移"的判断，
  把状态写进该文档并在汇报里点名依赖；**不要为了让队列表看着有进展而先跑一次迁移**。

### Q5. A7 外部锁导入（已显式顺延 v1.79.0）
- 除非 Q1–Q3 全部收口且余量充足，否则**保持顺延并写明理由**。若要做：需要新通道（含渲染器契约与 `npm run gen:web-api-map`）
  ＋ 一次真实环境构建验收；**不做半截**。

### Q6. 发 v1.79.0
- 前提：Q1–Q3 收口（Q4/Q5 若仍顺延则写进 CHANGELOG 的"明确没做、已立案"）。
- 流程：`CHANGELOG.md` 加代号行（**代号要新取一个**，两处：代号表 + 该版本小节标题）→ `README.md` 与 `README.en.md` 的**发布横幅逐字相同**（有 pre-push 守卫）
  → `package.json` 版本 → `git tag -a` → 推 tag 触发发布 → **正文必须自己写**（见下）→ 回读验证。
- **发布页正文（血泪教训）**：`node scripts/release-notes.mjs <版本> --print --certification <该 release 的 RELEASE-CERTIFICATION.json 资产>`
  → 删掉以 `release-notes:` 开头的行 → `gh release edit <tag> --notes-file <文件>` → **回读长度**（真正文数千字符；桩是 84–428）。
  作业里已有 ≥2000 的断言步骤，但那是**兜底**，不是许可。

## 收尾时（十点前）要能报的

1. 每项的提交号 + 门禁结论 + 证据（真机/真文件级读数，而不是"测试通过"）。
2. 明确列出**没做**的与**为什么**（依赖/顺延/阻塞都要具名）。
3. 工作区干净、无临时文件残留、隔离实例已停、端口无监听。
（与 v1.77.0/v1.78.0 同口径：宁可报"没做 + 原因"，也不报一个无法核对的"已完成"。）

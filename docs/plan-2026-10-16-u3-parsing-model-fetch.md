# v2.5.0 U3 方案：解析模型的校验式获取（会话认领，2026-10-16）

## 一 为什么不是填 `ENGINE_WEIGHT_SPECS`（一条必须先写下的纠正）

`src/shared/engine-weights.ts` 里那份 `ENGINE_WEIGHT_SPECS` 管的是**引擎**权重（pdb / esmfold 那一类），
消费方是设置页的**引擎矩阵**（`EngineMatrixSection.tsx:110/:129` 按四态渲染）、`engine-matrix-copy.ts`（每态已有翻译键）
与 `engine-routing.ts:151`（折叠路由建议语按 `weightDownloadPossible()` 分支）。
它的空表是**设计中的诚实状态**（注释原文：Empty is a real state, not a placeholder）。

**把解析模型（DECIMER 那一类）填进引擎表是范畴错误**：引擎矩阵会因此谎称某个引擎从此可以下载。
⇒ 本单元**不碰** `ENGINE_WEIGHT_SPECS`，也不改它的空表结论。

## 二 本单元做什么

给**解析模型**一条与引擎权重同纪律、但**独立**的获取路径：

1. 规格来源＝**随包清单** `resources/model-weights/manifest.json`（U2 已交付：首条 = DECIMER，
   `id/revision/url/sha256/bytes/license/kind/publisherMd5` 全部已核，sha256 由我方实算、并与发布方 md5 交叉核对通过）。
   条目形状与既有原语要求的 `WeightSpec`（`modelId/url/bytes/sha256/license`）**逐字段对应**，不需要第二套契约。
2. 获取＝既有原语 `src/main/engines/model-weight-cache.ts` 的 `downloadModelWeights`（**生产调用方至今为零**）。
3. 拒绝路径（本单元的验收核心）：
   - **不合规的摘要**（非 64 位小写十六进制）⇒ **拒且零字节落地**；
   - **内容被改**（取回后重哈希不符）⇒ **拒且不留残件**；
   - 读不到清单 / 清单无效 ⇒ 具名状态，不假装「没有可下的东西」。
4. 落点＝设置页「本地解析模型」那一区（`ProvidersPanel.tsx:402-415`，`data-testid="local-parsing-models"`）。
   该区今日**无任何控件**（注释：改不了任何事的控件比说明它为何不在这里的句子更糟）⇒ 本单元让它第一次有真控件：
   **显示条目（id / 体积 / 许可 / 我方 sha256 的截断）＋ 一个按需下载**（体积大 ⇒ 用户发起、显示大小、可取消）。

## 三 必须一并追平的后果

- `settings.localParsingModelsPlanned` 那句「本版尚未提供…v2.5.0 才会带来这些资产」在**能力落地之后即不再准确**
  ⇒ 本单元必须连同 9 语字典一起改写（九语：en zh zh-Hant ja ko de fr es ru；`fr` 的值含撇号、用双引号）。
- 主进程 ⇒ 渲染层的**投影**：只给类别与计数，**不给路径**（与支持诊断包 `parsing-models.json` 同规矩）。
  新增通道会牵动契约目录与多处账目副本 ⇒ 优先复用既有投影通道，改动面以最小为准。
- 拒绝路径必须有**用例**；且按本仓纪律做**变异验证**（把实现改成「降级放行」⇒ 用例必须红）。

## 四 明确不做

- 不把权重入仓（体积理由；清单与权重分离正是差异化的第 ② 条）。
- 不为不可达支路取读数，不把「未覆盖」写成「不存在」。
- 不删 `docs/evidence/*.md` 的在制路径，不改执行器正在改的 Specialist/plugin 轨道文件。

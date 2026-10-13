# A1 第三片：窗口侧翻译入口（缺口形状「能力在、界面上找不到」）

- 轮次：自主执行器 `2be4405e5dc6`，2026-10-13 上午
- 提交：`f4359ce6`（完整 40 位 `f4359ce6862118537a2e11307959beb421d58d98`）
- 单元边界：把既有的段落级 PDF 翻译接进窗口面。**不开新通道**（`pdf:translation` 是本片落的唯一
  一条，但它是「窗口侧翻译」这件事本身的那条缝，不是第二套读取路径）。

## 一 缺口是怎么核的（先核源码，不按记忆）

动手前按机制名 grep：`pdf:translation` 在改动前全树零命中，段落级翻译只有 agent 的工具面
（`pdf_translate` → `runDocumentTranslation`）。窗口里 `PdfPreview` 的工具条有标注/区域书签，
没有翻译入口 ⇒ 这正是「能力本体在、界面上找不到」那一类，不是「功能没做」。

## 二 交付（24 个路径，1 笔提交）

| 层 | 落点 | 要点 |
| --- | --- | --- |
| 主进程缝 | `src/main/translation/window-translation.ts`（新） | 读与跑同一处；文件按**路径**寻址、主进程 `ensureDoc` 解析成稳定 doc id（doc id 由 `path + time` 铸出 ⇒ 每次按下重新注册会让「已翻段落会被复用」无声失真）；答复的段落**来自盘上记录**，不来自本次跑的记账 |
| 判定共用 | `checkpoint-store.ts` 新增 `resolveCheckpointLoad()` | 跑与读共用同一判定 ⇒ 窗口不会显示一次运行拒绝复用的译文；四态具名：从未存过 / 文档变了 / 文件读不出 / 可用记录 |
| 一句话共用 | `run-translation.ts` 新增 `TRANSLATION_TARGET_UNCONFIGURED_DETAIL` + `translationTargetLookup()` | 窗口面与 agent 工具面对同一个缺失设置必须说同一句话 |
| 通道 | `settings/pdf-ipc.ts`、`src/main/ipc.ts`、装配 | handler 由装配处给；**缺省按名拒绝**（`pdf:translation is not configured.`），不静默回「0 段已翻译」 |
| 渲染器桥 | `preload/index.ts`、`preload/renderer-api.d.ts` | `pdf.translation(request)` |
| 面板 | `renderers/PdfTranslationPanel.tsx`（新） | **打开只读**（`run` 缺省不出现 ⇒ 打开文件不产生付费调用）；三拒绝各上各的屏且都不出现运行报告；报告带真模型与复用段数；导出走既有 `file:save-blob` |
| 工具栏 | `renderers/PdfPreview.tsx` | `Languages` 图标 + `data-slot="pdf-translation-toggle"`；能翻的条件只要「在项目里看着一个 PDF」 |
| 契约计数级联 | `application-command-composition.ts(+test)`、`host-application-commands.ts(+test)`、`preload/index.test.ts`、`renderer-contract-catalog.test.ts`、`renderer-surface-inventory.test.ts`、`renderer-argument-shape-characterization.test.ts`、`web-api-map.generated.ts` | 生产常量 363/361/128 不改会在启动时 `failInventory` fail-fast（那是产品缺陷，不是测试问题） |
| 用例 | `PdfTranslationPanel.test.tsx`（新，5 例） | 只读→按下两条调用的形状、行来自真构建器 `buildTranslationViewModel`、拒绝具名、无桥具名、导出文件名与被拒各一句 |

9 语字典的 14 个 `pdfTranslation.*` 键不在本片：它们由会话的 `4ab09f2b` 落盘（该提交同时退掉了
与我并行的重复面板），本片的用例断言的就是那批键。

## 三 门禁读数（本次运行，取在最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 `vitest`（translation/settings/preload/shared/renderer-web/两条命令面） | **225 文件 passed｜1 skipped**、**2933 passed｜3 skipped**，exit 0 |
| 面板簇 `previews/renderers` | 18 文件 / 163 passed |
| `typecheck:node` / `typecheck:web`（`--composite false`） | 两环原文各**零条 `error TS`**，exit 0 |
| `npx eslint --no-cache .` | **0 error / 120 warning**，exit 0；本片 24 个路径单独跑零输出 |
| `npx prettier --check`（24 路径） | All matched files use Prettier code style |
| `npm run check:web-api-map` | 无差异 |
| `scripts/pre-push-checks.sh` | exit 0（敏感词扫描：git 跟踪范围零命中） |

## 四 两条修法记录（都不是「放宽门禁」）

1. **`react-hooks/set-state-in-effect` 是 error 级门禁，且**追进 `useCallback`**。本片第一版把
   「这条桥不在」写在 `ask()` 开头 ⇒ effect 首次调用就带一条同步 `setState`，门禁正确地拦下。
   修法两道：把「桥在不在」改成**渲染期派生值**（`typeof window.api?.pdf?.translation !== 'function'`，
   桥不在 ⇒ 不出一次调用、直接上具名的那句话，按钮同时禁用）；再照**本仓既有先例**（
   `EndpointPanel.tsx` / `RoutinePanel.tsx` / `AnnotationDialog.tsx` 三处同款）给
   fetch-on-mount 那一行加具名豁免 —— 豁免此时**为真**：`ask()` 现在确实在任何 `setState` 之前
   先 `await`。
2. **顺带把「正在翻译…/禁用」这一半接活**：`setRunning` 原先被留在 `ask()` 里（撞同一条规则），
   现在移进点击处理器 ⇒ 按钮在运行中有它自己的态。测试断言不看它，但**不通电的按钮态就是空壳**。

## 五 未取（具名，不许读成已做）

- **真机读数未取**：内存闸门紧（空闲页 4,099 ≈ 64 MB、swap 4774/6144 已用），本机常驻 dev 实例
  编的是**13 小时前那棵树**（不含本片）⇒ 走 44100 的本地 Web RPC 也读不到这条通道；重启实例会
  在未干净的工作树上重建（树里另有会话的 83 份 `docs/evidence/*.md` 在制品，与会话 §六 第 2 步
  的前置条件冲突）。**本片因此只算「实现已落、证据待补」。**
- **认证 spec 未落**：窗口接缝的真机 spec（断言「接缝有应答，而不是 `No handler registered`」；
  `run` 缺省 ⇒ 不打网络、可无头确定性复现）与上一条同批，`blocked-by` = 树干净后重启实例。

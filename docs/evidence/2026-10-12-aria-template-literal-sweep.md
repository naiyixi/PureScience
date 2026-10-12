# 读屏名模板字面量收口：`attr template literal` 58 → 0（43 个新键 × 9 语）

> 本单元 = 队列档 §五十八「下一轮第一步」第 1 条（按形状逐个收口的下一个形状）。
> 形状：`aria-label={`Select ${skill.name}`}` 这类**用模板字面量拼出来的读屏名 / 提示名**。
> 审计器 `scripts/i18n-hardcoded-audit.mjs` 的 `attr template literal` 形状此前只被看一眼、
> 从未被收口；上一轮的顺手修复（`UpdateCapsule` 的 `aria-label`）已把 59 降到 58。

## 一 先量再动（读数与判据）

| 量 | 值 | 取法 |
| --- | --- | --- |
| 全树该形状命中 | **58 处 / 35 文件** | 审计器 `node scripts/i18n-hardcoded-audit.mjs` |
| 其中不同文案 | **51 个** | 独立扫描脚本（复刻同一正则与同一批行级过滤，自己重算，不引用审计器的汇总行） |
| 归并后的键数 | **43 个** | 把 `${…}` 归一成 `{name}` 后按文案去重（如 `Select ${candidate.name}` 与 `Select ${skill.name}` 同一个键） |

**独立性自证**：那支一次性扫描脚本（`/tmp`，未入库）在**同一次运行**里打印
`files=1196 hits=58`，与审计器同形状的 `58` 逐数字吻合 ⇒ 我手里的点位表就是审计器看见的东西，
不是另一套口径。收口后再跑：**`hits=0`**。

## 二 交付

1. **43 个新键**（`aria.*` 命名空间，读屏名/提示名集中一处便于审计）**× 9 语 = 387 条值**。
   经本技能自带的 `scripts/add-i18n-keys.py` 写入：九文件齐平预检 + 写后按 key 反查九个文件的**自证**
   （输出 `verified: 43 key(s) present in all 9 files`）。
   - 术语逐语言抄自**既有键**（`skill`→de `Fähigkeit`/fr `Compétence`/es `Habilidad`/ru `навык`、`runtime`→fr `environnement`/es `entorno`/ru `среда`、`session`→zh-Hant `工作階段`），避免同一术语在两种语境译成两个词。
   - 未放宽任何质量门：`KEPT_IN_ENGLISH`、`LATIN_COGNATES`、`TERMINOLOGY_RULES`、zh-Hant 简体残留表**一个字符都没改**。
2. **58 处站点全部改走 `t('aria.…').replace('{name}', …)`**，插值**留在组件内**（本仓有套件走不插值的
   fallback 字典，`t(key, vars)` 会让断言拿到裸 `{x}`；既有 441 条带占位符的键都是这个用法）。
   数值型插值显式 `String(...)`（`${index + 1}`、`${exportAllCount}`）。
3. **5 个文件原本没有 `t` 绑定**（`CompletedJobCard` / `RemoteJobRow` / `artifact-preview` /
   `HtmlPreview` / `PdfThumbnail`）⇒ 按本仓既有约定补 `import { useLanguage } from '@/i18n'` + 组件内
   `const { t } = useLanguage()`。钩子一律放在**第一个提前返回之前**（`MessageImageList`、
   `MessageUploadAttachmentList` 都有 `if (…length === 0) return null`）。
4. **相邻的一处同文案**：`ProviderList` 的 `<TooltipContent>Speaks the {endpoint.full}</TooltipContent>`
   与它自己的 `aria-label` 是同一句话、同一屏 ⇒ 同批收口（该形状读数 5 → 4，差值 1 就是这一处；剩余的
   3 处是 `Versions.tsx` 的 `Electron v{…}` 等，属别的形状/别的批次）。

## 三 英文值**逐字不变**（这是设计属性，不是巧合）

43 个键的 en 值都写成与改动前那条模板字面量**逐字符相同**的字符串。因此：

- 英文界面（含 **全部 e2e 与认证 spec 的默认语言**）渲染出的读屏名与改动前一致 ⇒ 按
  `getByRole('button', { name: 'Open actions for …' })` / `getByLabel('Select …')` 定位的既有 e2e
  （`e2e/workspace-conversation.spec.ts`、`e2e/electron-foundation.spec.ts`、`e2e/workspace-files.spec.ts`、
  `e2e/certification/references-screening.spec.ts`、`e2e/certification/session-package-round-trip.spec.ts`）
  **一行都不用改**。
- 中文界面从此不再向读屏播报英文（这正是本单元要修的东西）。

## 四 `tsc` 抓到的 14 处 —— 为什么这一步不能省

第一遍改完直接跑 `vitest`（先不跑 tsc）时，全量会是绿的：**`vitest` 只转译不做类型检查**。
`tsc -p tsconfig.web.json` 一次报出 14 处，全部是**只有类型检查看得见**的形状：

| 红 | 真凶 | 收法 |
| --- | --- | --- |
| `Cannot find name 't'`（`PermissionsPanel:167`、`PreviewPanel:447`、`WorkspaceMessageItem` 6 处） | 文件里**有** `useLanguage()`，但那些行在**另一个子组件**里（`PermissionRow` / `PreviewTab` / `MessageImageList` / `ArtifactCard` / `MessageUploadAttachmentList` / `MessagePartsContent`）——grep 到 `t` 就以为全局可用，是假象 | 各子组件内补自己的 `const { t } = useLanguage()`（`MessagePartsContent` 是 `=> (…)` 直返 JSX，改成块体 + `return`） |
| `TS2769`（`SkillImportView:353`） | `scannedRepo` 是 `string | null`，`replace(…, string)` 不吃 `null` | `scannedRepo ?? ''`（与改动前渲染该值的 JSX 插值行为一致） |

**收法都不用 `as` 或可选属性**：前者会把这件事从检查器眼前藏起来，后者等于悄悄降级契约。

## 五 三条既有断言按新契约改定位（**收紧**，不是放宽）

| 红 | 原因 | 收法 |
| --- | --- | --- |
| `SkillImportApprovalDialog.render.test.tsx`「Invert 用用户语言」：`[aria-label="Select Second Skill"]` 取不到 | 该用例跑在 zh 语言下，而断言钉的是**英文**读屏名 —— 这正是本单元修的缺陷本身 | 改按 zh 名 `选择 Second Skill` 定位，并**加一条** `expect(… '[aria-label="Select Second Skill"]').toBeNull()`（英文名往后不许再出现） |
| `SpecialistsPanel.render.test.tsx` 两条「用用户语言」用例：`[aria-label="Actions for RNA Reviewer"]` 取不到 | 同上（触发器的可访问名此前是英文模板字面量） | 改按 `RNA Reviewer 的操作` 定位，并把文件里那句已过期的注释（"trigger's accessible name … still English"）就地更正 |

两条都是**改定位、不改断言本意**；新增的那条 `toBeNull()` 是**加**的判据，不是放宽。

## 六 门禁读数（全部实跑，数字取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 审计器 `attr template literal`（全树） | **58 → 0**（独立扫描脚本同批复核：`hits=0`） |
| 审计器全形状总量 | 158 → **99**（−59 = 58 处本形状 + 1 处相邻同文案的 TooltipContent） |
| `vitest src/renderer/src/i18n` | 4 文件 / **52 passed**（含翻译质量门与 zh-Hant 简体门） |
| 全量 `vitest run --maxWorkers=4` | **1247 passed \| 16 skipped（1263 文件）**、**16122 passed \| 207 skipped（16329 条）**，exit 0，324 s |
| `tsc` node / web（`--composite false`） | exit 0 / exit 0 |
| `eslint --no-cache .` | **0 error / 122 warning**（122 为既有基线，本轮 44 文件未新增一条） |
| `prettier --check`（本轮 44 文件） | CLEAN |
| `bash scripts/pre-push-checks.sh` | exit 0（品牌/借词扫描零命中、双语头部一致） |

## 七 刻意的边界（不许读成「已做」）

1. **没有真机窗口读数**：本单元是纯渲染层文案 + 钩子，`t` 的真语言提供器由既有渲染用例覆盖；
   起 Electron 的内存闸门仍关（本单元开工读数：空闲物理页 ≈ **63 MB** / swap 已用 **4,000 MB of 5,120 MB**）。
   要补的话配方与判据在 `docs/evidence/2026-10-12-short-labels-sweep-zero.md` 一类同族证据档里。
2. **`MessagePartsContent` 那个文件的 diff 含大段纯缩进**（块体化后 prettier 重排整个 JSX 体，
   `WorkspaceMessageItem.tsx` 记 **85 增 / 79 删**）：语义改动只有「加钩子 + 3 个读屏名」，
   其余是同一次改动的必然重排，不是顺手扫到的无关漂移。
3. **`dquote`（70）/ `jsx prose line`（10）/ `jsx-text`（9）等形状仍未收口** —— 其中
   `src/main/connectors/descriptors/**`、`src/main/reviewer/**` 那批 `dquote` 命中大量是
   **agent/日志读的指令文本**，按本仓口径**固定英文、不本地化**（不是缺口，收口时须逐条判性质，
   不能按数量一刀切）。
4. **`jsx-text before interpolation` 还剩 4 处**（`Versions.tsx` 的 `Electron v{…}` 等）——下一个形状批次的活。

# 整行短标签清零（56 处 → 0）与 35 个新键 × 9 语（2026-10-12，执行器）

> 上一轮（队列档 §五十七）把 45 处整行短标签改走既有 `common.*` 键，并把这一形状加进
> `scripts/i18n-hardcoded-audit.mjs`（工具本身此前看不见它）。本轮把**这个形状剩下的全部**收口：
> 全树读数 **56 → 0**，并顺带修掉 UpdateCapsule 那条同族的模板字面量读屏名。
>
> 本轮不改通道、不改契约、不改 store —— 纯渲染层文案 + 九语字典 + 两处守卫措辞。

## 一 开工读数（先量）

| 读数 | 值 | 口径 |
| --- | --- | --- |
| 全树整行短标签 | **56 处 / 47 个词** | 判据 = 该行 `strip()` 后是裸词，且前一非空行以 `>` 结尾、后一非空行以 `</` 开头 |
| 与上一轮的关系 | 上一轮 §五十七 记「101 → 56」 | 上一轮那个「修复后 55」是**重放路径子集**（392 文件）上的读数；全树一直是 56。本轮读数与上一轮的**全树**读数一致，未出现新站点 |
| 其中已有同值键可复用 | **18 处** | 逐站点核语义后再选键，见第二节 |
| 其中需要 9 语新键 | **38 处** | 见第三节 |

## 二 复用既有键（18 处，零新键）

判据：**词相同 + 概念相同**才复用；概念不同的一律新开键（否则一个键的语义漂移会连带改掉另一处界面）。

| 站点 | 字面量 | 键 |
| --- | --- | --- |
| `ReferencesLibraryDialog.tsx` | PDF | `settings.fileTypePdf` |
| `ExportConversationDialog.tsx` ×2 | Markdown / PDF | `settings.fileTypeMarkdown` / `settings.fileTypePdf` |
| `NotebookPreview.tsx` · `NotebookPreview` 单元标签 | Markdown | `settings.fileTypeMarkdown` |
| `LinkSafetyModal.tsx` · `ClaudeIsolatedSignInModal.tsx` | Copied | `ws.copied` |
| `ClaudeIsolatedSignInModal.tsx` | Copy | `settings.copy` |
| `AgentHomeImportView.tsx` · `SkillImportApprovalDialog.tsx` | Invert | `skillUpload.invert` |
| `ConnectorDetailView.tsx` | Featured | `settings.featured` |
| `SkillImportView.tsx` | Imported | `settings.imported` |
| `SpecialistsPanel.tsx` ×2 | Done | `settings.done` |
| `ArtifactProvenancePanel.tsx` | Execution Log | `ws.executionLog` |
| `PreviewFileSurface.tsx` | Provenance | `preview.provenance` |
| `SessionPlanSurfaces.tsx` | Approve | `plan.approve` |
| `HomePage.tsx` · `OnboardingWizard.tsx` | PureScience | **不是字典键**：品牌名改走 `APP.name`（与同页 `Join the ${APP.name} community…` 同一单一来源） |

**刻意不复用而新开键的例子**（防语义耦合）：`Port`（SSH 端口）本可复用 `settings.proxyPortLabel`，
但代理端口与 SSH 端口是两回事——那个键将来的措辞变更会连带改错这处界面；`Clear`（技能编辑器）
不复用 `settings.visionModelClear`，`Remove`（计算主机）不复用 `runtimes.removeNamedEnv`，
`Input`/`Output`（工具调用明细）不复用 `ws.usageInput`/`ws.usageOutput`（**词元用量**的标签，概念不同）。

## 三 新键 35 个 × 9 语 = 315 条值

- 写法：本技能自带的 `scripts/add-i18n-keys.py` + 一份 `key\tlang\tvalue` 的 TSV；
  脚本自带「九文件齐平 + 每键九语齐全」预检（不合格**一个文件都不写**）与**写后按 key 反查九文件**的自证 ——
  它打印的是 `inserted 35 key(s) × 9`，自证行是 `verified: 35 key(s) present in all 9 files`。
- **值不凭空写**：凡该词在既有字典里已有译文（`Download`/`Send`/`Clear`/`Preview`/`Default`/`Packages`/
  `Pinned`/`Saved`/`Host`/`Port`/`Notebook`/`Remove`/`Enable`/`Input`/`Output`），新键的九语值**逐语言抄自那个既有键**
  ⇒ 同一术语在两种语境下不会译成两个词。剩余 20 个词逐语手写。
- **两处白名单扩充（都是"不可译的名字"，不是放宽质量门）**：`KEPT_IN_ENGLISH` 增 `Discord`（品牌）与
  `Slurm`（调度器名，与既有的 `sbatch`/`qsub` 同类）。两条都写在白名单条目旁边，注明依据。
  未放宽 `LATIN_COGNATES`，未改任何既有条目的译文。

## 四 屏上真的换了字（三条中文复读用例，真语言提供器）

| 用例 | 位置 | 断言 |
| --- | --- | --- |
| 命名环境的「Packages」动作读中文 | `RuntimesPanel.render.test.tsx` | 该控件 `textContent` = **软件包**（不是 `Packages`） |
| 技能导入审批的「Invert」读中文 | `SkillImportApprovalDialog.render.test.tsx` | 键 **反选** 可达且 `Invert` 不存在；点它之后选择**真的**反转（第二个候选变选中） |
| 计算主机「pinned」徽标 | `ComputeHostDetail.render.test.tsx`（就地加强） | 徽标仍出现、文案随字典；**全大写外观移到 CSS**（`uppercase`），所以中文用户看到的是「已固定」而不是英文 |

前两条走 `LanguageProvider` + `localStorage zh`（渲染层真提供器），第三条是既有用例的就地加强。

## 五 门禁读数（全部实跑）

| 环 | 读数 |
| --- | --- |
| 审计器（本形状，全树） | **56 → 0** |
| `vitest run src/renderer/src/i18n`（含质量门） | 4 文件 / **52 passed** |
| 定向 `vitest`（本轮两份新增/加强用例所在文件） | RuntimesPanel + SkillImportApprovalDialog **56 passed**；ComputeHostDetail + app-branding **12 passed** |
| 全量 `vitest run --maxWorkers=4` | **1247 passed \| 16 skipped（1263 文件）**、**16122 passed \| 207 skipped（16329 条）**（首跑 16120 → 本轮 +2 恰为新增的两条中文复读用例），exit 0，275 s |
| `tsc` node / web（`--composite false`） | exit 0 / exit 0 |
| `prettier --check`（本轮文件） | CLEAN |
| `eslint --no-cache .`（全仓，CI 同口径） | **0 error / 122 warning**，exit 0（122 是既有基线；单跑本轮 47 个源文件 **无任何输出**） |
| `bash scripts/pre-push-checks.sh` | exit 0（含品牌禁用词扫描；无一处命中） |

### 首跑抓到的两条真实回归（都在既有守卫里，且都是「守卫在守一件真事」）

1. `src/main/app-branding.test.ts` 的「home 面必须出现产品名」是**按字面量**扫 `HomePage.tsx` 的：
   改成 `{APP.name}` 后它红了。**这是守卫的判据过时，不是守卫想守的事没了** ⇒ 收法是**双端钉住**：
   加一条「`src/shared/app-config.ts` 里 `name: 'PureScience'`」，并把 home 面那条改成断言
   `{APP.name}` 绑定 —— 从此这个面**不可能**与产品名漂移（比原来的字面量断言更强）。
2. `ComputeHostDetail.render.test.tsx` 断言 `PINNED`。文案改走字典后大写不再写在字面量里 ⇒
   **把全大写做成 CSS**（`uppercase`）而不是把断言改成小写：视觉不变，中文可读，断言改后仍守「徽标出现」这件事。

## 六 未取 / 边界（具名）

1. **真机窗口读数未取**：本单元是纯文案，界面半边由「真语言提供器」的渲染用例作证；起 Electron 需要内存闸门
   （开工读数：空闲物理页 ≈ 111 MB / swap 已用 4.0 GB of 5.1 GB）。配方（内存宽松时一次跑完，跑绿后提交）：
   隔离工作树 `git worktree add /tmp/<名> <提交>` + 软链 `node_modules` → `npm run build:e2e` →
   Electron 带 `--user-data-dir` + `PURESCIENCE_STORAGE_ROOT` + 独立端口 + 隔离 `settings.dataRoot`，
   在 **Settings → General** 读 `官网`/`Discord` 两个社交入口（本轮改了两个 keys）。
2. **相邻的同族缺陷未做（不是本形状）**：`ComputeHostDetail.tsx` 的 `Probing…`/`Probe`/`Save`/`Not set. Will be
   updated from $SCRATCH…`、`SessionPlanSurfaces.tsx` 的 `Describe changes, or type “approve”…`、
   `NotebookPreview.tsx` 的 `{n} 个 Markdown 单元`（**硬编码中文**）—— 它们属别的形状（`jsx prose line` /
   `attr template literal` / 中文字面量），审计器各形状的清单里各有其位；本单元只收「整行短标签」这一形状。
3. `UpdateCapsule.tsx` 的读屏名（模板字面量 `Update available: ${…}`）是**顺手**修的（同一组件、同一提交，
   新键 `update.availableAria`，插值留在组件内用 `.replace('{v}', …)`）；「模板字面量读屏名」这个形状整体
   （59 处 / 36 文件）仍是下一批。

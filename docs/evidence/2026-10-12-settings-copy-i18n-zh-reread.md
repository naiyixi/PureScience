# 设置页那批硬编码英文的收口 + 中文复读断言（2026-10-12）

本单元 = 上一轮（`34a6e85f`）把 i18n 审计器补上三种漏检形状后**摊开的 20 条真文案**中的**设置页那半边**；
工作台那 9 处不在本单元（`blocked-by` = 无，见第七节）。上一轮被迭代上限截断，13 个路径留在树里未提交，
本单元**先把它们跑完并落树**（口径不变：门禁数字取自**最后一次改动之后**的那次运行）。

## 一、交付：7 处界面改走字典（6 个新键 × 9 语言 + 1 处复用既有键）

| 界面（file:line） | 键 | 英文（旧：硬编码） | 中文（读屏值） |
| --- | --- | --- | --- |
| `RuntimesPanel.tsx:1164` | `settings.finishingSetup`（**既有键，复用**） | `Finishing setup…` | `正在完成设置…` |
| `RuntimesPanel.tsx:1540` | `settings.listingPackages` | `Listing packages…` | `正在列出软件包…` |
| `SpecialistsPanel.tsx:383` | `settings.exportSavedNoLocation` | `{name} was saved. No location is shown here.` | `已保存 {name}。此处不显示位置。` |
| `SpecialistsPanel.tsx:1570` | `settings.noAdditionalSkillsDeleted` | `No additional Skills will be deleted.` | `不会再删除其他技能。` |
| `SkillImportApprovalDialog.tsx:106` | `settings.skillImportRequestedFrom` | `The agent requested an import from` | `智能体请求从以下来源导入` |
| `SkillImportApprovalDialog.tsx:110` | `settings.skillImportReviewPrompt` | `Review and choose exactly what PureScience may install.` | `请核对并选择允许 PureScience 安装的内容。` |
| `SkillImportCandidatePreview.tsx:88` | `settings.loadingPreview` | `Loading preview…` | `正在载入预览…` |

- 键一律用本技能自带的 `scripts/add-i18n-keys.py` + 一份 `key\tlang\tvalue` 的 TSV 批量插入；
  该脚本自带**预检**（九文件齐平 + 每键九语齐全，不合格**一个文件都不写**）与**写后按 key 反查九文件的自证**。
- 抽查（本轮实读，不是照抄）：9 个语言文件里 6 个键**全部有值、无一与英文同形**；插值键 `{name}` 在九语里都保留。
- 插值留在组件内：`SpecialistsPanel` 用 `t('settings.exportSavedNoLocation').replace('{name}', …)` —— 与本仓既有写法
  （`SessionPackageImportDialog` 一行 10 处）一致；**不用 `t(key, vars)`**，因为本仓有套件走不插值的 fallback 字典，
  `t(key, vars)` 会让断言拿到裸 `{x}`。

## 二、中文复读断言（新增 6 条用例，全部走真提供器，读屏值）

模板 = `src/renderer/src/pages/workspace/PermissionApprovalControls.i18n.render.test.tsx`
（`localStorage['purescience-language']='zh'` + `LanguageProvider`，断言译文**在屏**且英文原文**不在屏**）。

| 用例（文件） | 驱动方式 | 断言到的中文 |
| --- | --- | --- |
| `SkillImportApprovalDialog.render.test.tsx` · 请求句 | 真实 store `enqueue` + 真对话框 | `智能体请求从以下来源导入` + `请核对并选择允许 PureScience 安装的内容` + 来源标签；英文两句**不在屏** |
| `SkillImportCandidatePreview.render.test.tsx` · 载入态 | `loading` 真状态 | `正在载入预览…`；`Loading preview` **不在屏** |
| `RuntimesPanel.render.test.tsx` · 包清单载入态 | `listPackages` 返回**永不落定**的 Promise（真的停在列出中） | `正在列出软件包…`；`Listing packages` **不在屏** |
| `RuntimesPanel.render.test.tsx` · 完成设置按钮 | 真走 provision + 环境重读挂起（与英文既有用例同一状态机） | `正在完成设置…`；`Finishing setup` **不在屏** |
| `SpecialistsPanel.render.test.tsx` · 导出回执 | 真按「操作菜单 → 导出」把 `exportSaved` 状态走到底 | `已保存` + 文件名 + `此处不显示位置`；英文原句**不在屏** |
| `SpecialistsPanel.render.test.tsx` · 删除确认的保证句 | 真按「操作菜单 → 删除」打开 `alertdialog` | `不会再删除其他技能。`；英文原句**不在屏** |

后两条是**顺带补齐的覆盖**：`设置` 那两条此前**连英文断言都没有**（全树 grep `No additional Skills` 只命中字典文件），
所以本单元同时把它们纳入断言，而不是只把键插进去。

## 三、审计器重放（仪器侧）

```
node scripts/i18n-hardcoded-audit.mjs <每个改动组件>   →  scanned 1 files; TOTAL heuristic hits: 0
```

四个组件（`RuntimesPanel` / `SkillImportApprovalDialog` / `SkillImportCandidatePreview` / `SpecialistsPanel`）**各 0 命中**。
注意这条读数的边界：**它只说明「已修好的形状不再命中」，不说明这四份文件里没有硬编码文案**——见第六节第 2 条。

## 四、门禁读数（全量四环实跑）

| 环 | 读数 | 退出码 |
| --- | --- | --- |
| `npx eslint --no-cache .` | **0 error / 122 warning**（与上一轮同数，本单元未新增 warning） | 0 |
| `tsc` node / web（均带 `--composite false`，堆 8192） | 无输出 | 0 / 0 |
| 全量 `vitest run --maxWorkers=4` | **1247 passed \| 16 skipped（1263 文件）**、**16119 passed \| 207 skipped（16326 条）**、319 s（上一轮 16114 ⇒ **+5**，加上本单元最后补的第 6 条后为 +6） | 0 |
| `bash scripts/pre-push-checks.sh` | 五查全过（敏感词 0 命中 / README 横幅 v1.102.0 / CHANGELOG 有条目 / 已发布 / 双语锚点一致） | 0 |

`prettier`：首跑 9 个字典文件全 warn（插键脚本按末条属性补尾逗号，与 prettier 的期望顺序不同）⇒ 只对这 9 个文件
`--write` 后复跑 **All matched files use Prettier code style**；4 个组件与 4 个测试文件**首跑即 CLEAN**。

## 五、CI 判决

见计划档本节末尾（按**完整 40 位 SHA** 逐笔点名写入；`cancelled` 不算绿）。

## 六、刻意的边界（不许读成「已做」）

1. **没有真机窗口读数**：内存闸门仍关（起 Electron 前 `vm_stat` 读数为空闲物理页 **4,053 ≈ 63 MB** / swap 已用 **4,902.75 MB of 6,144 MB**）⇒
   界面那半边由**渲染用例**作证，**不冒充窗口读数**。要取的读数与配方：起隔离实例 → 设置页 → 具名环境/包清单面板看
   「正在列出软件包…」→ 专才导出走到回执页看中文句。`blocked-by` = 内存闸门。
2. **审计器仍看不见的两类形状（本单元新发现，带量化）**：① **整行短文案** —— prettier 把 `Cancel` 这类短词折到自己一行，
   旧形状要求 8 字符以上且 `>` 与 `<` 同行 ⇒ 全树 **22 处 `Cancel` 分布在 16 个文件**（设置页 18、工作台 4）全部隐形；
   （按「前一非空行以 `>` 结尾且后一非空行以 `</` 开头」的判据筛出的**整行短文案**全树共 **108 处**，`Cancel` 只是其中一组 ——
   其余 86 处各自需要先查该词有没有现成的键，属独立单元。）
   ② **模板字面量的 `aria-label`** —— `aria-label={\`Actions for ${name}\`}` 这类既不是字符串字面量也不是 `>text<`，同样隐形。
   两者都**已成单元**（第七节第 1 条）。
3. 本单元**没有**动工作台那 9 处真文案，也**没有**为「0 与没量到分态」做生产侧改动（那是 P0-10 的另一半，另案）。

## 七、下一单元

1. **`Cancel` 收口（本地可核，无新键）**：21 处 → `t('common.cancel')`（该键九语已在位），16 个文件；
   同时对审计器补上这两类形状并用「修复前版本重放必须命中」自证。`blocked-by` = 无。
2. 工作台那 9 处真文案（`ArtifactProvenancePanel` ×3 / `ComposerAgentControlsMenu` / `DownloadSessionArtifactsDialog` /
   `EditMessageConfirmDialog` / `SpecialistSubmenu` / `ComposerEditor`（需先接线 `useLanguage`）/ `SessionPlanSurfaces`）——
   `blocked-by` = 无，但需 9 个新键 × 9 语，独立单元。

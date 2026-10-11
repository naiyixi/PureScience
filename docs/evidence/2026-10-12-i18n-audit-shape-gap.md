# i18n 硬编码审计器的三种漏检形状（本轮补上，并用「已知坏版本」做回归）

> 单元来源：上一单元（删项目回执）自查时发现的**仪器缺口**——`scripts/i18n-hardcoded-audit.mjs`
> **不报**那个文件，而它当时满屏硬编码英文。缺口被记在
> `docs/evidence/2026-10-12-project-deletion-release-receipt.md` §七。
>
> 本单元是**纯工具链**改动（不占版本位），判据写在工具自己身上：
> **拿修复前的版本重放，它必须命中**；拿修复后的版本重放，它必须沉默。

---

## 一、漏检的三种形状（都对源读过，不是猜的）

被测对象 = 修复前那份 `DeleteProjectDialog.tsx`（`git show cdad14d5:…`），它当时有三个形状：

| # | 形状 | 原文 | 旧扫描器为什么看不见 |
| --- | --- | --- | --- |
| 1 | **独立成行的 JSX 文本** | `. Generated artifacts and uploaded files stored by PureScience will also be deleted.` | 现有形状要一行里同时出现 `>` 与 `<`（或 `>` 与 `{`）。prettier 把长文案折到自己一行后，`>` 留在**上一行**的标签上 ⇒ 一行都没有可锚的尖括号。 |
| 2 | **插值之后的整行文字** | `{t('home.deleteProjectHint')} be undone.` | 现有形状 `>\{…\} text<` 要求插值前有 `>`、文字后有 `<`，两者都不在同一行；**并且**行级过滤器 `ignoreLine` 见到 `t(` 就把整行跳过——而这一行正是"用了 `t()` 却还拼了英文"的形状，恰恰最该被看见。 |
| 3 | **模板字面量开头的英文片段** | `` ? ` and its ${dialogSessionCount} …` `` | 现有六个形状里没有一条盯模板字面量；这段文字是**拼在别处**的用户可见文案。 |

## 二、交付（一个脚本，三段可复跑的读数）

`scripts/i18n-hardcoded-audit.mjs`：

1. **新增三种形状**：`jsx prose line`（整行纯散文、要求句末标点，字符类**排除** `= ; { } $ ` 反引号
   ⇒ `const x = 1` 这类语句永远读不成文案）、`jsx prose after interpolation`（行首一个或多个插值之后的散文，
   **显式允许它跑在"看起来像代码"的行上**——那行就是缺陷本身）、`template literal prose fragment`
   （`` ` 空格+英文 … ${ ``）。
2. **模板片段形状要求前导空格，这是量出来的不是拍的**：不要求时全树 **520** 命中，逐条看是 CSS 工具类
   （`h-full rounded-full bg-primary …`）与 testid（`shortcut-row-`）；要求前导空格后 **2** 命中，
   两条都是真片段。这条判据写进了脚本注释，防止后人"顺手放宽"。
3. **可对单个文件/目录重放**（argv 形式，缺省仍是两个根）：形状 1–3 的漏检**只能在旧版本上证明**，
   而旧版本不在树里 ⇒ 没有这个入口，任何"我修好了仪器"的说法都无法取证。显式路径时文件数下限降为 1
   （缺省根仍要求 500，防遍历写错时静默全绿）。
4. **按形状打印命中数**：一个形状的命中数爆炸时，要修的是那个形状，而不是把它当成待办清单。

## 三、读数（全部实跑）

| 读数 | 值 |
| --- | --- |
| **已知坏版本重放**（`git show cdad14d5:src/renderer/src/pages/home/DeleteProjectDialog.tsx` → 临时文件） | **3 命中**，三种形状各 1：`and its` / `Generated artifacts and uploaded files stored by PureScience will also be deleted.` / `be undone.` |
| **修复后版本重放**（同一路径的当前文件） | **0 命中** |
| **全树（修复前扫描器）** | 1196 文件 / **86 命中 / 48 文件** |
| **全树（修复后扫描器）** | 1196 文件 / **106 命中 / 63 文件** |
| **差值校验** | 106 − 86 = **+20**，恰等于三种新形状的命中数（15 + 3 + 2）⇒ **没有一条旧命中被新过滤器吃掉**（这一点是刻意保住的：过滤器跑在**未 trim** 的原始捕获上，显示才 trim） |
| 新形状命中样例（逐条人工过目，全部是真文案） | `Loading preview…` / `Finishing setup…` / `Review and choose exactly what PureScience may install.` / `Resend on a new branch?` / `At the start of the input, use Up and Down Arrow to browse prompt history.` / `Invalid Plan document. This preview cannot be displayed.` / `Retained entries begin ${…}` / `exited with code ${code}` |
| `eslint --no-cache scripts/i18n-hardcoded-audit.mjs` | 0 error / 0 warning（先 `prettier --write` 单文件，未全仓 `--fix`） |

## 四、口径边界（不许读成别的东西）

1. 这份工具**不是 CI 门禁**（脚本头注释写明），它的产物是**待办清单**；本单元改的是**它看得见什么**，
   不是"硬编码英文已经清零"。
2. 106 条命中里 `dquote` 一族 70 条包含**刻意不本地化**的文本（agent 指令、日志），**不都是缺陷** ——
   这正是它没有做成门禁的原因。
3. 三种新形状**只覆盖"整行/片段"这一族**；跨行拼接的其他形态（例如把英文拆进多个相邻 JSX 表达式）
   仍可能漏 ⇒ 仪器永远只能报它被写出来的形状，这不是"已经全知"。

## 五、本轮新出现的待办（下一单元的输入，不是本单元的交付）

新形状一次就摊开 **20 条真文案**（15 条整行 JSX + 3 条模板片段 + 2 条插值后散文），
集中在设置/工作台的面板载入态与确认框（`RuntimesPanel` / `ArtifactsProvenancePanel` / `SpecialistsPanel` /
`ComposerAgentControlsMenu` / `EditMessageConfirmDialog` / `SkillImportApprovalDialog` 等）。
它们**尚未处理**——本单元只让它们可见。处理它们 = 一次 9 语插键 + 渲染断言，独立单元。

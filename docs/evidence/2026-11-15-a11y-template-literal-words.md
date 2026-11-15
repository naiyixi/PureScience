# 插在括号之间的那些英文词：七个面的模板串提示语收进九语字典

日期：2026-11-15（执行器）
提交：本笔（`fix(renderer)` 系列第四批，紧接 `74469cb0`）

## 一 缺陷形状

上一笔把 `aria-label`/`title` 里的**整句字面量**收进了字典。同一个缺陷还有第三种写法：
**英文词夹在插值之间**。

```tsx
aria-label={`${label} runtime`}                    // label 是翻好的，runtime 不是
aria-label={`${grants!.length} allowed this session`}
aria-label={`${name} scrollable preview`}
aria-label={`${step.title} status: ${status}`}
aria-label={`${t('fileBrowser.goTo')} parent directory`}
aria-label={`${t('settings.show')} repositories`}
aria-label={`${… ? t('ws.removeFailed') : 'Cancel'} attachment ${name}`}   // 'Cancel' 在表达式里
```

这类字符串**不是任何一条字典值**，所以：

- 上一笔那条「英文值不得作为字面量出现」的守卫看不见它（值对不上）；
- `scripts/i18n-hardcoded-audit.mjs` 也看不见它（它读可见正文，不读 JSX 属性表达式）；
- 表面上一切正常：可见正文是中文，只有读屏软件念出来、或鼠标停在按钮上时才是英文。

## 二 本笔改了什么

| 面 | 改前（模板串里的英文） | 新键 |
|---|---|---|
| 运行时面板的环境分区 | `` `${label} runtime` `` | `a11y.runtimeSection` |
| 技能导入的仓库折叠键 | `` `${…} repositories` `` | `a11y.repositoriesSection` |
| 输入框动作菜单的授权计数徽标 | `` `${n} allowed this session` `` | `a11y.grantsThisSession` |
| 对话面板的附件取消键 | `'Cancel'` + `attachment ${name}` | `a11y.cancelAttachment` / `a11y.removeFailedAttachment` |
| 本地文件浏览器的上级目录键 | `` `${…} parent directory` `` | `a11y.parentDirectory` |
| PDF 预览的滚动区 | `` `${name} scrollable preview` `` | `a11y.scrollablePreview` |
| 计划预览的步骤状态点 | `` `${step.title} status: …` `` | `a11y.stepStatus` |

新键 8 个 × 九语（72 条），`en` 与 `zh` 不同形；`zh-Hant` 用繁体字形（`執行環境` / `上層目錄` / `可捲動`）。
词序按各语言给：`fr` 是 `Environnement d'exécution : {label}`，`ja` 是 `リポジトリを{action}`，
`de` 是 `{label}: Laufzeitumgebung` —— 不把英文语序硬套到别的语言上。

**附件那一处是两个键而不是一个**：`Cancel attachment {name}` 与 `Remove failed attachment {name}` 是
两个不同的动作（失败态下按钮做的是「移除失败的附件」），合成一个键就等于让一个键承担两种含义。

## 三 守卫（第三种载体，树级扫描）

`status-wording-guard.test.ts` 加一条**全树**扫描（不是逐面）：

- 扫 `src/renderer/src/**` 下所有 `.ts`/`.tsx`（排除测试文件），取 `aria-label`/`title` 属性值是**模板串**
  的那些；
- 把 `${…}` 段剥掉，只留**插值之间**的字面文字，出现 ≥2 个连续 ASCII 字母即判为 offender；
- 自证：断言扫描文件数 > 400、命中模板串 > 3 —— 遍历写错时不会静默全绿。

`${row.project} — ${row.title}`、`${method} ${url}` 这类**纯数据拼接**不受影响（插值之间没有字母）。

同时把 6 个面并进 `SURFACES` 逐面清单（该印的 key 必须被引用；英文值不得作为字面量出现）。

## 四 门禁（本机实跑）

| 环 | 读数 |
|---|---|
| 全树扫描（本笔的判据本体） | 522 个源文件；模板串 offender **7 → 0** |
| 定向 vitest（`src/renderer/src/i18n`，含守卫与翻译质量门） | 5 files / 57 passed |
| 定向 vitest（`pages/workspace` + `pages/settings` + `components`） | 314 files / 3200 passed、1 skipped |
| 双 typecheck（node + web，`--composite false`，堆 8192） | 0 / 0 |
| `npx eslint --no-cache`（本笔全部改动文件） | 0 problems（exit 0） |

## 五 边界与具名未办

- 扫描只看 `aria-label` / `title` 两个属性的**模板串**写法。**表达式里夹的单引号英文**（`… : 'Cancel'`）
  这一种只能逐面钉（本笔把对话面板并进了 `SURFACES`），树级规则没做——按「属性值里哪些引号内容是文案、
  哪些是 CSS 类名/枚举值」需要语义判断，硬做会造出一张误报表。实测全树这类引号字面量 19 处，其中 18 处是
  `"group"` / `'system'` / `"true"` 这类**非文案**值，只有对话面板那一处是真缺陷（已修）。
- `toast` 标题、原生菜单项、系统通知标题仍未普查（跨进程，渲染层扫描够不着）。
- 无真机窗口读数：本笔不新增数据路径，取证 = 真 `LanguageProvider` 渲染套件 + 上述门禁；装机版随下一次
  发版生效。读屏实际念出的句子要在装机版上复听，属**具名未取**。

## 六 下一轮第一步

`toast` 标题与原生菜单项（主进程侧文案目录），或回到缺陷队列里 `needs-attention-notification` 卡片上
`left_on_remote` 未枚举态的说法。

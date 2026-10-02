# R4-U4 / R4-U3 的面板级读数（浏览器级，2026-10-02）

这两片此前一直挂着一句诚实的话：**「面板的浏览器级读数未取」**——逐页理由与 `rotatedPages` 提示只在
服务层（`pdf:tables` 的真实返回）和 jsdom render 测试里覆盖过，没有一次「真实例 + 真 PDF + 真界面 DOM」的读数。
本轮把它补上，并且**固化成一个认证 spec**，从此不是一次性取证而是每次 CI 都跑的读数。

## 一、方法（真机，不是模拟）

- **真实窗口**：`e2e/fixtures/electron-app` 启动真实 Electron 应用（`out/` 的 dev 构建，本轮 `npm run build:e2e` 后
  `out/main/index.js` = 13:28:54），Playwright 驱动真实渲染进程，**点击的是文件自己的菜单**（预览卡右键 → Table 面板），
  不是直接注入状态。
- **真 PDF**：假 agent 夹具**手写**两个 PDF（不依赖任何生成器，与既有 `table-evidence.pdf` 同一套构造器）：
  - `prose-evidence.pdf`：5 行散文（单列），行数过门、列数不过门 ⇒ 唯一可能的原因就是 `too-few-columns`。
  - `rotated-table-evidence.pdf`：6×4 的真表，每个单元格用 **90° 文本矩阵** `[0 1 -1 0 -y x]` 放置——
    这正是「内容矩阵旋转」的形态（页 `/Rotate` 不是缺陷，见 `r4-u3-rotation-investigation.md`）。
    矩阵绕原点旋转 ⇒ 旋转内容在用户空间必然落在负 x，故该页的 `/MediaBox` 相应放宽到 `[-760 -40 612 792]`。
- **读数来源**：面板渲染出的 DOM 文本（`data-testid` 定位），即用户会看到的那句话。

## 二、读数（逐字，来自真实运行的 DOM）

| 断言 | 实测文本 / 值 |
| --- | --- |
| 散文页空结果行 | `No table candidate in the 1 page(s) scanned.` |
| 散文页具名理由行（`pdf-table-rejection-1`） | `Page 1: too-few-columns — rows 5, columns 1, rows spanning the columns 0; the shape test needs 2+ rows and 2+ columns.` |
| 散文页候选数 | `0`（`pdf-table-candidate` 计数 0 —— 有理由时不出候选，抑制规则在界面上同样成立） |
| 旋转页形态行（`pdf-table-shape`） | `6 rows x 4 columns`（含 `6 rows x 4 columns` 断言；缺陷形态是 4 行 1 列） |
| 旋转页坐标提示（`pdf-table-rotated-1`） | `Page 1: its content stream is rotated 90°, so the coordinates below were normalized to upright — they will not line up with the page as displayed.` |
| 旋转页表头行（`pdf-table-row-0` 的 `<td>` 文本） | `["Gene","log2FC","p-value","adjP"]` |
| 旋转页不得同时报「没有表」 | `pdf-table-rejections` 计数 `0`、`pdf-table-empty` 计数 `0` |

判定口径与代码里的判定**同源**：散文页的 `rows 5 / columns 1` 就是 `measureTableShape` 量出来的数字，
`2+ rows / 2+ columns` 就是抽取器自己的下限（`DEFAULTS.minRows/minColumns`）——面板没有第二份判定。

## 三、复现

```bash
npm run build:e2e                     # 裸 electron-vite build 会 OOM，用这个脚本
./node_modules/.bin/playwright test \
  e2e/certification/pdf-table-panel-reasons.spec.ts \
  e2e/certification/pdf-table-extraction.spec.ts
```

本轮实测输出（2 例，19.7s）：

```
  2 passed (19.7s)
```

两条读数同时被 `e2e/certification/pdf-table-extraction.spec.ts`（既有：真表 4×4 + 面板列一致）一并跑过，
确认共享的 PDF 构造器改动没有动到既有夹具。

## 四、边界（仍然具名，不夸大）

- 本 spec 跑在**本机 macOS + dev 构建**上；CI 里它属于 `npm run test:e2e:p0`（`e2e/certification`），
  以平台矩阵的口径运行，本文件记录的是本机这一次的读数。
- 这一轮覆盖的是**面板**（用户看到的那一层）。夹具在用户空间把 `/MediaBox` 放宽以容纳旋转内容，
  这与「真实旋转内容流坐标也在负区」是同一回事，但**没有**覆盖「真语料里整页旋转的表」——
  真语料里该形态不存在（见调查报告 §3：语料内的角度文字全是 45–65° 的图内标签）。

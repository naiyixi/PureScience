# 对话框焦点归还（无 Trigger 一族）— 实测证据 2026-09-26

## 目标

Radix 关闭对话框时靠聚焦它自己的 `Dialog.Trigger` 归还焦点；本应用绝大多数对话框由**页面状态**打开
（`<Dialog.Root open={...}>`），Root 里没有 Trigger，且页面在关闭时是**整体卸载**而不是走 close 事件
⇒ 焦点落到 `<body>`，键盘用户被打回文档顶部。本单元把 `useDialogFocusRestore` 接到所有这类对话框上，
并留下防复发守卫。

## 普查读数（改动前，`grep`/脚本统计非测试文件）

| 口径 | 数量 |
| --- | --- |
| 含 `Dialog.Content` 的 `.tsx` | 49 |
| 其中没有 Trigger / 受控开关注入点 | 23 |
| 其中既无 `Dialog.Close` 也无 `onCloseAutoFocus`（候选面） | **22** |
| 已修好的先例 | 5（`GlobalSearchDialog`、`KeyboardShortcutsDialog`、`FolderGrantsPanel`、`AnnotationDialog`、`SessionBookmarksDialog`） |
| **未纳入本单元**：含 `AlertDialog.Content` 的文件 | 21，其中 **20** 同样无 Trigger/归还处理 |

## 改动

- 钩子 `src/renderer/src/components/ui/dialog-focus-restore.ts` 强化：新增"对话框之外的最近焦点"跟踪
  （`focusin` 捕获监听，忽略落在 `[role="dialog"]` 内的目标），打开时优先取"当前确实在外部的活动元素"，
  否则回退到跟踪值。
- **22 处**接线：`onOpenAutoFocus`/`onCloseAutoFocus` 接到各 `Dialog.Content`（其中 `ContextWindowDialog`
  用组合写法：先让钩子捕获、再放它自己的 `contentRef` 焦点；`ConnectorApprovalDialog` 的钩子置于提前返回之前）。
- 守卫 `dialog-focus-restore-coverage.test.ts`：凡渲染 `Dialog.Content` 而无 `Dialog.Trigger` 的文件，必须用
  该钩子或带 `focus-restore-exempt: <理由>` 注记；另有"扫描文件数 > 200"的自检，防止遍历静默失败被读成合规。
- 钩子单测 `dialog-focus-restore.test.ts`（6 条）。

## 真机读数

### ① 焦点落点探针（临时 spec，读数后已删）

```
改前：[probe] after focusing the rail button: BUTTON | Settings
      [probe] settings open:  INPUT | Search settings… | input     ← React autoFocus 在 commit 阶段先跑
      [probe] settings closed: BODY                               ← 记下的"开者"是对话框内部元素，已卸载
改后：[probe] settings closed: BUTTON | Settings                   ← 归还到真正开它的控件
```

### ② 常驻真机断言（`e2e/accessibility.spec.ts`）

新增用例 `dialogs opened from page state hand focus back to their opener`：

- 设置面：侧栏 `Settings` → Enter → 对话框可见 → Escape → 断言侧栏按钮**重新获焦**；
- 工作区文件预览：文件行按钮 → 预览对话框 → 关闭按钮 → 断言**该文件行按钮重新获焦**。

```
npx playwright test e2e/accessibility.spec.ts --workers=1
→ 5 passed (45.0s)      # 含既有 4 条（键盘闭环等）
```

### ③ 单元与静态守卫

```
npx vitest run src/renderer/src/components/ui/dialog-focus-restore.test.ts \
               src/renderer/src/components/ui/dialog-focus-restore-coverage.test.ts --maxWorkers=4
→ Tests 8 passed (8)   # 6 条钩子 + 2 条守卫
npm run typecheck      → 0 error
npx eslint <改动文件>  → 0 error
npx prettier --check   → All matched files use Prettier code style
```

## 第二族：AlertDialog（同流程，先证实再改）

守卫扩到 `AlertDialog.Content` 后报出 **20 个文件 / 22 个实例**。先量后改：先在打包应用上验证这一族是否
真丢焦点（临时探针，设置→存储→「Change location」→ 预警确认框；读数后已删）：

```
opener focused:          BUTTON | Change location
alertdialog open:        BUTTON | Cancel          ← AlertDialog 打开时聚焦自己的 Cancel 按钮
closed via Escape:       BODY | All projects…     ← 开者仍在 DOM 里
closed via Cancel:       BODY | All projects…
opener still connected:  true
```

两条关闭路径（Escape / 自带 Cancel）焦点都落 `<body>`，开它的按钮**仍连接** ⇒ 与 Dialog 族同缺陷，
接线站得住。随即接线 20 文件 / 22 实例，并修正钩子的层判定：
`[role="dialog"]` → `[role="dialog"], [role="alertdialog"]`（否则 AlertDialog 打开时聚焦的 Cancel 会被
跟踪器当成「层外元素」记下，关闭时把焦点交给一个正在卸载的控件）。

### 真机断言（`e2e/accessibility.spec.ts` 第二条焦点用例）

`alert dialogs hand focus back to their opener as well`：侧栏 Settings → 存储 → `Change location` →
Enter ⇒ 预警确认框；**Escape** 关闭 ⇒ 断言 `Change location` 重新获焦；再用它自己的 **Cancel**（打开时
它自己聚焦的那个按钮）关闭一次 ⇒ 同样断言归还。

## 未覆盖（已立案为下一单元）

- 真机断言覆盖设置面、工作区文件面、存储预警确认框三处；**引导页 `LocationStep`** 的确认框已按代码接线
  （守卫覆盖），但尚未纳入真机断言；
- 焦点归还只断言「回到开者」，未断言「开者已被卸载时不抛错、且落点合理」的真机行为（jsdom 单测覆盖该分支）。

## 旧版未覆盖记录（已被上一节取代）

- `AlertDialog.Content` 一族（21 个文件中 20 个同类），守卫目前只守 `Dialog.Content`；
- 真机断言只覆盖设置面与工作区两面，**引导页那处对话框**尚未纳入。

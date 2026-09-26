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

## 第三件：嵌套模态的 Escape 只关最内层

第二族收口时观察到"确认框上按 Escape 会把底下的设置面一起关掉"，本轮落地为修复 + 真机断言。

- **机制**：Radix 把 Escape 监听挂在 `document` 上 ⇒ 一层里的按键被每一层都收到 ⇒ 设置面与上层确认框同时
  `onOpenChange(false)`。失败读数（修复前真机）：Escape 后界面回到工作区、`Change location` 按钮已不存在。
- **修法（单点）**：`SettingsPage` 的 `Dialog.Content` 上加 `onEscapeKeyDown` —— 有更上层时 `preventDefault()`
  关自己，并把同一个 Escape 转发给最上层（`closeActivePane` 同款手法）。转发事件会回到同一监听器 ⇒ 组件内 ref 标志防回环。
- **两个坑（写进注释）**：Radix 回调里 `event.currentTarget` 是 `document` 而非该 Content ⇒ "目标是否在本层内"
  必须换成"目标是否落在最上层内"；无转发标志会死循环（实测 521 次反复关闭）。
- **真机断言**：`alert dialogs hand focus back to their opener as well` 内追加 —— Escape ⇒ 确认框关、
  **设置面仍在**、焦点回 `Change location`。整份 `e2e/accessibility.spec.ts` **6 passed (1.4m)**。
- **覆盖方式说明**：本条只由真机用例锁。jsdom 复现不出 Radix 的两层同关——我写的第一版 jsdom 用例在停用守卫后
  **仍通过**（空断言），已删除，不留在仓库里冒充覆盖。

## 覆盖盘点与归档（不留未认领项）

真机断言已覆盖三处：**设置面**、**工作区文件预览**、**存储预警确认框（嵌套层）**。余下两条按「审计归档零代码收口」处理，理由可核查：

- **引导页 `LocationStep` 的确认框**（已按代码接线、守卫覆盖，但未纳入真机断言）——**归档，原因是可核查的阻塞**：
  ① 该确认框只在「选了自定义数据目录」后出现（`LocationStep.tsx:98` 的 `chosenParent` 分支）；
  ② 夹具用桥接层 `settings.markOnboardingComplete()` **直接跳过整个向导**（`e2e/fixtures/electron-app.ts:264-273`），
  向导五步（`environment→agent→provider→notebook→location`）都没走过；
  ③ 选目录只能走原生文件夹选择器（`storage:pick-directory` → `showOpenDialog`），e2e 无注入点（主进程虽有
  `deps.showOpenDialog` 这个既有注入位，但要在启动期读环境变量并在夹具里补启动选项，属"为一个断言加生产测试缝"）。
  ⇒ 该对话框与已验证的 AlertDialog 是**同一组件、同一钩子、同一接线形态**（`LocationStep.tsx:230-231`），差的是
  可达路径而不是行为；若要让这块也上真机，做法已写明（加 `PURESCIENCE_E2E_PICKED_DIRECTORY` ⇒ 夹具启动选项 ⇒
  走完向导五步），可按需开工。
- **「开者已被卸载时不抛错」的真机行为**——归档：该分支由钩子单测覆盖，真机上「开者被卸载」等价于"整块界面被
  替换"，此时没有可归还的控件、断言只能是"不抛错"，信息量低于其成本。

## 旧版未覆盖记录（已被上一节取代）

- `AlertDialog.Content` 一族（21 个文件中 20 个同类），守卫目前只守 `Dialog.Content`；
- 真机断言只覆盖设置面与工作区两面，**引导页那处对话框**尚未纳入。

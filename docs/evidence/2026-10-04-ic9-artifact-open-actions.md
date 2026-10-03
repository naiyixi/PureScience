# IC9 产物「用系统程序打开 / 在文件夹中显示」— 真机证据（2026-10-04）

## 缺口是什么

`artifacts:open-file` 与 `local-fs:reveal` **能力本体早就在**（handler、契约项、preload 成员三处齐），
但**没有任何面向读者的入口**：产物预览面的动作行只有 Download / 书签 / 溯源，读者手里拿着文件却没有
「打开」这条路。这就是本仓口径里的「能力半存在、交互层缺失」。

## 一、先确认通道在窗口里被应答（不再只查「有没有调用点」）

用一次性探针在真窗口直呼四个候选通道，**传一个不存在的路径**——具名拒绝算应答，
`No handler registered` 才算死（上一轮 `settings:*` 三个通道就是这么判出来的）：

| 通道 | 结果 | 读数 |
|---|---|---|
| `localFs.reveal` | ALIVE | `resolved: undefined` |
| `localFs.openPath` | ALIVE | `resolved: "Failed to open path"` |
| `artifacts.openFile` | ALIVE | `Artifact file is outside artifact storage.` |
| `compute.revealInFolder` | ALIVE | TypeError（我把参数形状造错了，通道本身应答） |

⇒ 选定 **`artifacts.openFile`**（而不是 `localFs.openPath`）：它先走 repository 解析
（`src/main/artifacts/ipc.ts:209-223`，先试产物版本定位符、再解析托管路径），
**`shell.openPath` 永远看不到未托管位置**，落在存储外的路径由 `storage-access.ts:100` 具名拒绝。

## 二、入口做在哪

`src/renderer/src/pages/workspace/ArtifactFileOpenActions.tsx`（新）挂在 `PreviewFileSurface` 头部
`ManagedFileDownloadButton` 旁边，取的就是预览项自己的 `item.path`（与 Download 同一个值）。
两个控件是**显式按钮**不是藏进菜单——手里拿着文件的人正是需要它的人。
拒绝时把**handler 自己的话**印在 `artifact-open-failure` 上（`role="status"`），成功后清除。

## 三、真机读数

```
npx playwright test e2e/certification/artifact-open-actions.spec.ts --workers=1
[ic9] open-with-system label: Open with system app
[ic9] show-in-folder label: Show in folder
[ic9] both controls answered with no refusal
1 passed (13.3s)
```

真产物（`sendPrompt('Create a table PDF fixture.')` → `table-evidence.pdf`）→ 真预览面 → 两个控件
均可见、均点击后**无具名拒绝** ⇒ 打开动作真的把托管路径交给了系统、reveal 真的调起了文件管理器。

## 四、真实运行够不到的那一半，钉在 jsdom 里

「handler 拒绝」在真机上到不了（预览项的路径永远合法），所以拒绝的**渲染**放在组件旁的渲染测试
（`ArtifactFileOpenActions.render.test.tsx`，2 passed）：断言拒绝以 handler 的原话上屏、且下一次成功
会把它清掉（拒绝不许比它说的那个文件活得更久）。

## 五、九语种

3 键 × 9 份字典（`previewSurface.openWithSystemApp` / `showInFolder` / `openFailed`），
zh ≠ en；`translation-quality` 守护 42 passed。

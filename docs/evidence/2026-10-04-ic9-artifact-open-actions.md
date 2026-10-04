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
均可见、均点击后**无具名拒绝** ⇒ 打开动作真的把托管路径交给了系统。

> ⚠️ **2026-10-04 更正（见 §六）**：上面那次「无具名拒绝」是**假绿**——当时「在文件夹中显示」走的是
> `localFs.reveal`，它对**非绝对路径**的拒绝发生在一个本 spec 不读的旁路上（渲染层只记 fingerprint、
> 不印消息），于是同一次点击在打包态 macos runner 上是**确定性失败**。这一条读数已被 §六 取代。
>
> 同类教训：§一 的通道存活探针「`localFs.reveal` ALIVE / `resolved: undefined`」也是**读数无歧义性**
> 不足的例子——我传的路径不成立，通道答的是「没有可显示的东西」，与「路径不合法」长得一样。
> 探针必须传**这一类调用真实会传的参数**，否则测到的是通道在、而不是路径能过。

## 四、真实运行够不到的那一半，钉在 jsdom 里

「handler 拒绝」在真机上到不了（预览项的路径永远合法），所以拒绝的**渲染**放在组件旁的渲染测试
（`ArtifactFileOpenActions.render.test.tsx`，2 passed）：断言拒绝以 handler 的原话上屏、且下一次成功
会把它清掉（拒绝不许比它说的那个文件活得更久）。

## 五、九语种

3 键 × 9 份字典（`previewSurface.openWithSystemApp` / `showInFolder` / `openFailed`），
zh ≠ en；`translation-quality` 守护 42 passed。

## 六、打包态抓出的真缺陷与修复（2026-10-04）

### 缺陷

打包态 macos runner 上 IC9 的 spec **确定性失败**（retry #1 同样失败），P0 认证作业唯一的红点：

```
e2e/certification/artifact-open-actions.spec.ts:20:5 › a managed artifact preview opens with
the system app and shows in the folder       1 failed / 6 skipped / 51 passed
```

CI 上传的 `p0-test-results-macos-arm64` 的 `error-context.md` 直接给出了页面上的原话：

```
Could not open: Error invoking remote method 'local-fs:reveal': Error: Local path must be absolute.
```

根因：预览项的 `item.path` 对**带版本的产物**是
`artifact-version:<project>/<session>/<artifact>/<version>` 这个**定位符**，不是文件系统路径。
「用系统程序打开」没有这个问题，因为它走 `artifacts:open-file`（先解析定位符、再交给 OS），
而「在文件夹中显示」当时走的是**没做解析**的 `localFs.reveal` ⇒ 每台机器、每一次都拒。
**同一个文件、两条 OS 交接路径，只有一条做了解析**——这就是缺口本体。

### 修法（照搬本仓既有同语义先例：`logs:open-file` / `logs:reveal-in-folder` 是成对的）

- `src/main/artifacts/ipc.ts`：抽出**唯一**解析函数 `resolveOsHandoffPath`（定位符走 provenance、
  托管路径走 repository），`openFile` 与**新增** `revealFile` 共用它；`reveal` 与 `openPath` 一样可注入
  （默认 `shell.showItemInFolder`）；注册 `artifacts:reveal-file`。
- 契约面一条 LOCAL 命令：`renderer-contract-catalog.ts` + `data-content-application-commands.ts`
  （命令定义 / 组数组引用 / `assertLocalCaller` 派发）+ preload 桥 + `renderer-api.d.ts` +
  `gen:web-api-map` 重生成。
- **计数连锁六处全改**（`application-command-composition.ts`：internal 346→347、localWeb 344→345、
  remoteWeb 223 不变、rejected 121→122；以及 catalog/invoke/安装面 352→353、457→458、382→383；
  preload 225→226 / 187→188 与各面清单）。
- 渲染层 `ArtifactFileOpenActions.tsx` 改走 `window.api.artifacts.revealFile({ path })`，
  **不再碰 `localFs.reveal`**。
- 守卫（**不是把断言改松**）：渲染测试用定位符路径渲染，断言两个动作都交给 artifacts 面、
  且 `localFs.reveal` **从未被调用**；主进程侧断言「OS 拿到的是 `realpath` 解析后的真路径」+
  「存储外路径被拒且文件管理器一次也没被调」。

### 修复后的真机读数

```
npm run test:e2e -- e2e/certification/artifact-open-actions.spec.ts
[ic9] open-with-system label: Open with system app
[ic9] show-in-folder label: Show in folder
[ic9] both controls answered with no refusal
1 passed (12.4s)
```

同一次运行里 IC10 的 spec 也 1 passed，两条合跑无相互干扰。

### 教训（写进本档免得再犯）

1. **同一文件的两条交接路径必须共用同一次解析**；只做一条，另一条就是「点了没反应」。
2. **「通道应答了」不等于「参数能过」**：存活探针必须传这类调用真实会传的参数（这里是定位符），
   否则读到的是「通道在」而不是「路径能过」。
3. 打包态与 `out/` 的时序/旁路差异会让渲染层的拒绝**不打印**：这种红只在 CI 出现，
   归因要读 CI 上传的 `error-context.md`（页面原文），不要从本机复跑结果反推。

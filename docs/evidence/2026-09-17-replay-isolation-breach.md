# 重跑"隔离"被击穿 —— 12.2 的根因量清了（2026-09-17）

**一句话**：隔离重跑**没有**在隔离目录里跑代码。它把代码跑在**原会话的 notebook 数据根**里，而评分只看隔离目录 —— 于是"重跑完成但没产出文件"的具名结论，量出来是**路径缺陷**，不是脚本没写。

## 一、代码级链路（每一步都读过实现）

```
replay-owner.execute({code, cwd=隔离目录})
  └─ ports.executeNotebook({ sessionId: version.appSessionId,   ← 原会话 id
                             workspaceCwd: <隔离目录>, code, ... })
       └─ notebookCommands.execute(request) → runtime-service.execute
            └─ sessionLifecycle.ensure(request)
                 └─ sessions.getOrCreate(sessionId) → repository.loadOrCreate({sessionId, workspaceCwd})
                      ├─ run.json 存在（原会话跑过，必然存在）→ 载入原文档
                      │    session.cwd = document.dataRoot      ← 原会话数据根，workspaceCwd 被忽略
                      └─ run.json 缺失（只有全新会话才走）→ 新文档
                           workspaceCwd 记进文档，但 dataRoot 仍由 getNotebookDataRoot(storageRoot, project, sessionId) 决定
```

两个关键事实：
1. `session-lifecycle.ts` 给会话的 `cwd` 是 **`document.dataRoot`**，不是请求里的 `workspaceCwd`；
2. `repository.normalizeDocument` 里 `dataRoot = getNotebookDataRoot(storageRoot, projectName, sessionId)` —— **永远由存储根派发**，与 `workspaceCwd` 无关（`workspaceCwd: request.workspaceCwd ?? document.workspaceCwd` 只是记一笔）。

⇒ 即使给重跑换一个全新的 sessionId，代码也只会跑在 `<存储根>/notebooks/<项目>/<新会话>/data`，**依然不是**评分所在的 `/tmp` 隔离目录。

## 二、运行时证据（一次性探针，真跑）

探针项目 `cmu52bmb60000wf89xnbbec3f`，真实回合产出 `finalized` 版本 `c0cedf14-a2e2-40d0-aa39-d659ae4c4a6f`（268 B CSV，notebook run `artifact-run-1789621317503-2`）。

```
$ purescience replay c0cedf14… --project cmu52bmb6… --session e6d58897… --artifact dcbee1c5…
verdict:    unverifiable
mode:       re-run
origin:     executed
env lock:   not-applied
ran:        notebook:python in 134ms (exit 0)
reason:     Not verifiable: the re-run finished without producing replay_probe.csv, so there is nothing to compare

重跑前后 1 秒内被写/改的文件（全存储在 ~/PureScience-DEV 上按 mtime 找）：
  …/notebooks/cmu52bmb6…/e6d58897…/data/replay_probe.csv     ← 代码写在这里（原会话数据根）
  …/notebooks/cmu52bmb6…/e6d58897…/run.json                ← 重跑记录
  …/runtime/provenance/environment-manifests/70471d30….json ← 环境清单
```

**代码确实跑了、文件确实写了**，位置是 `…/notebooks/<项目>/<原会话>/data/`；评分读的是 `/tmp/ps-replay-*`（`readProduced(workspace, input.outputPath)`）。两边不是同一个目录 ⇒ 具名 `unverifiable`。

## 三、这不只是"结论说错"，还是两个真问题

1. **隔离语义不成立**：重跑会**写进原会话的工作目录**（本次覆盖了同名的 `replay_probe.csv`）。重跑本应是只读原数据、在隔离目录里重做的验证动作；现状下它可以改动原会话的工作文件。
2. **评分位置错**：`unverifiable` 的原因文案（"重跑完成但没有产出 X"）把**路径不一致**说成了**没有产出**——这也是我先前不敢下结论的那条边界，现在量清了。

## 四、修法（立案，未实施）

端口契约本来就写着 "Runs the code through the app's own notebook execution, **in the given working directory**" —— 是 notebook 层没兑现它。修法按代价从低到高：

- **(A) 推荐**：给 notebook 执行请求加一个**按次**的工作目录（如 `workingDirectory?: string`），由 `execution-owner.executeDataCell` 在该次运行内生效、**不写回会话 cwd**（会话 cwd 是持久的，改了会连带影响用户后续运行）。重跑走这条路 ⇒ 真正隔离 + 评分目录一致。
- **(B) 不可取**：重跑里给代码前置 `os.chdir(隔离目录)` —— 会话的 kernel 是**长驻**的，chdir 会留在 kernel 里，且隔离目录跑完就被删 ⇒ 用户后续运行会落在已删除的目录里。
- **(C) 不完整**：只给重跑换新 sessionId —— 不再覆盖原会话（解决真问题 1），但 dataRoot 仍由存储根派发，**评分依旧找不到**（真问题 2 未解）。

落地时必须：先跑 notebook 模块既有测试（`execution-owner` / `runtime-service` / `session-lifecycle` 相关），再加"按次工作目录只影响该次运行、不写回会话"的用例；重跑用例断言产物落在**传入的隔离目录**里。

## 五、本次核验的诚实边界

- 证据是**一次真跑**（jest 之外的真实 CLI + 真实 notebook + 真实文件系统），探针项目跑完即删；未改任何真实项目的数据。
- 修法 (A)/(B)/(C) 的取舍是**读实现的推论**（kernel 长驻、dataRoot 派生规则都已在实现里读到），**尚未用实验证实**；实施时要用测试把它们钉死。
- 探针项目 `cmu52bmb60000wf89xnbbec3f` 已删除（`REMAINING_PROBES` 复验为空）。

## 六、修了一半：结论不再骗人（`f6effce` + 投影修复，同日现场复验）

**先说清"修了什么、没修什么"**：这一轮修的是**结论的诚实性**（重跑不再把"写到了别处"说成"没有产出"），**隔离本身依旧被击穿**——那属于执行层（kernel 的 cwd 是 spawn 时定的进程属性），另行立案。

### 6.1 侦破过程（一路实测，不靠推断）

第一次实现后现场跑，文案**仍是旧的**，于是逐层排查：

1. `out/main/ipc-*.js` 里确实有我的新分支与新文案 ⇒ 跑的不是旧代码；
2. 加一次性调试日志（用完即删），量到适配器实际收到的对象只有四个键：

```
[replay-debug] {"keys":["status","stdout","stderr","environmentManifestChecksum"],"status":"completed"}
```

3. ⇒ 真凶在 `replay-composition.ts`：它把 notebook 的运行摘要**投影**成四个字段时，把 `cwdBefore`/`cwdAfter`（也就是"代码实际跑在哪个目录"）**丢掉了**。摘要里有，投影没带。

### 6.2 修法

- `replay-composition.ts`：投影带上 `cwdBefore`/`cwdAfter`（completed 与 failed 两条都带）；
- `replay-owner.ts`：把运行目录作为 `ranIn` 交给 runner，并提供 `producedOutsideWorkspace`（去那个目录看文件在不在）；
- `replay-runner.ts`：产物不在评分目录时，**按实测的目录如实说明**，不再一律说"没有产出"；适配器报不出目录时保留旧句（不臆断）；
- 用例：`replay-runner.test.ts` 新增两条（命名真实目录 + 文件确在那边 / 目录已知但文件不在那边），旧句用例保留作"无信息时不臆断"的守卫。

### 6.3 现场复验（同一台机、真实 DB、真实 kernel）

```
$ purescience replay a5036dbe… --project cmu52jzcp… --session 5fb7fe6d… --artifact 0372f564…
verdict:    unverifiable
mode:       re-run
origin:     executed
env lock:   not-applied
ran:        notebook:python in 822ms (exit 0)
reason:     Not verifiable: the re-run executed in
            /Users/totota/PureScience-DEV/notebooks/default-project/5fb7fe6d-…/data
            instead of the isolated workspace /var/folders/…/T/ps-replay-zwRi5f,
            and wrote replay_probe.csv there — the directory being graded never received it
```

从此再看到 `unverifiable`，能一眼分清是"真没产出"还是"写到了评分目录之外"——这正是 12.2 当初卡住的原因。

### 6.4 仍未解决 / 未覆盖（不许含糊）

- **隔离仍不成立**：重跑依旧在原会话数据根里执行（本次复验同样如此，文案已如实说出）。修法需在执行层给"按次工作目录"，而 kernel 的 cwd 是 **spawn 时**定的进程属性（`kernel-executor.ts:512/543`），既有 kernel 无法在不重启的前提下换目录 ⇒ 要先定"重跑用独立会话 + 环境绑定从哪来"（记录里的 `env lock: not-applied` 也指向同一处设计）。
- **覆盖缺口（已补）**：`replay-composition.ts` 原本没有单元测试，那个投影缺陷因此无人拦截。已新增 `replay-composition.test.ts` 两条用例（目录必须进结论 / 报不出目录时保留旧句），并**实测过守卫会咬人**：撤掉投影修复 → 第一条失败，恢复 → 2/2 绿。提交 `d6fde32`。
- **隔离真修的设计（本轮定案，实施为下一单元）**：现有事实已足够定案——kernel 的 cwd = `session.cwd` = `document.dataRoot` = `<存储根>/notebooks/<项目>/<会话>/data`（`session-lifecycle.ts:86` 定会话 cwd；`kernel-executor.ts:512/543` 用它 `spawn`），而 `workspaceCwd` 只是文档里的一个字段、**不参与** spawn。因此"按次工作目录"在既有 kernel 上不可行（要么 chdir 留在长驻 kernel 里，要么重启 kernel 丢掉用户会话状态）。**定案做法**：重跑改用**独立的重跑会话**（`replay-<versionId>`），把**评分目录直接设成该会话的 dataRoot**（而不是 `/tmp` 的 mkdtemp 目录），运行时绑定从原会话文档移植（`bindRuntime`/`switchRuntime` 这条既有能力），跑完关掉 kernel 并清理该会话与目录。这样"代码跑在哪"与"评分读哪"天然一致，也不再碰原会话的工作文件。要知道的信息都有了（绑定可移植、dataRoot 可预测、清理路径明确）；实施时按序：先跑 notebook 模块既有测试 → 改执行路径 → 加"产物落在本会话 dataRoot 且评分通过"的用例 → 现场复验一次。

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

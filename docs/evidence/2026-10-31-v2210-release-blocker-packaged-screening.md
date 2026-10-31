# v2.21.0 发版阻塞：打包态筛选停摆 —— 本机复现与定因

日期 2026-10-31 18:4x CST｜仓库 `/Users/totota/purescience`｜提交 `abed77e7`（含本轮加的 screening 日志）

## 0 一句话

v2.21.0 的 `Release` 卡在 `Build macos-arm64` 的 p0（`references-screening` 四件套 + 一条 spec 陈旧），
`publish` 被 skip，**GitHub 上没有 Release 页**。本轮用**打包态本机复现**拿到了定因：模型调用发出去了，
40 秒后会话被 dispose、agent 进程被 SIGTERM，于是面板永远停在 `0 / N processed`。

## 1 怎么复现的（本机，隔离配置根）

```bash
npx electron-vite build && npx electron-builder --dir      # dist/mac-arm64/PureScience.app
PURESCIENCE_E2E_EXECUTABLE=dist/mac-arm64/PureScience.app/Contents/MacOS/PureScience \
  npx playwright test e2e/certification/references-screening.spec.ts --workers=1 --timeout=300000
```

两个要点：

- 第一次尝试死在夹具的 **120 s 测试超时**（打包态冷启动比 dev 慢），所以第二次用 `--timeout=300000`
  **从命令行**给足时间，没有为了复现去改 spec；
- 应用仍跑在夹具的 `PURESCIENCE_E2E_STORAGE_ROOT` 隔离根上（`resolveE2eStorageRoot` 对任何构建都优先），
  没有碰真实配置根 `~/.purescience`。

## 2 读数（本轮新加的日志，原样）

```
[screening:model] screening record started { backend: 'opencode:p_1793443626178_1', … timeoutMs: 120000 }
[screening:model] screening record started { backend: 'opencode:p_1793443626178_1', … }
[screening:model] screening record failed {
  backend: 'opencode:p_1793443626178_1',
  durationMs: 40247,
  timedOut: false,
  toolUse: false,
  kind: 'model-or-other',
  message: 'Active session disposed'
}
[screening:model] screening record failed { … durationMs: 40249, message: 'Active session disposed' }
[acp] agent process exit { code: null, signal: 'SIGTERM' }
```

三条事实：

1. **调用是发出去过的**（两条 `started`），所以不是「模型没被调用」；
2. **不是超时**：`timedOut: false`，两条都在 **40.2 s** 挂掉，而每条记录的截止是 **120 s**；
3. `Active session disposed` 是 **ACP SDK** 的报错（`node_modules/@agentclientprotocol/sdk/dist/acp.js`）——
   会话在对端被销毁后仍被使用；紧接着 `[acp] agent process exit { signal: 'SIGTERM' }`，即
   **这个 screening 专用后端（`opencode:p_<ts>_1`）的 agent 进程被杀了**。

⇒ 面板停在 `0 / 2 processed` 的直接原因：**打包态下，每次 pass 起的受限后端在 ~40 s 被终止**，
两条记录都拿到 `Active session disposed`，引擎按「模型失败」记账，一条都没落地。
dev 构建 13.3 s 就通过，因此这是**打包态才出现**的路径差异 —— 正是用户装正式包会遇到的那一类。

## 3 没有做的事（不夸口）

- **没有修**：还没定位到是谁在 40 s 杀掉那个连接。`src/main/acp/connection-resource-owner.ts:241` 是执行
  `kill()` 的地方，往上的调用链（受限后端准备、空闲回收、pass 结束清理谁先跑）还没走完。
- **没有放宽任何门禁**、没有重跑单个 job、没有动 tag。
- 视觉回归那条（`home-empty.png` 差 3%）**不是发版阻塞**：`build.yml` 的判决只看
  `packaged_app` + `p0`（macos-arm64）+ 平台 smoke，视觉那条在文件里被明确写成 informational。
  我上一轮把它算进阻塞项，这里更正。

## 4 恢复发布的路径（等修完）

tag `v2.21.0` 在 `dd984e5a`，**没有 Release 页** ⇒ 可以 `git tag -d v2.21.0` → 在新提交上重打 → 推 tag
→ Release 自动 publish。（有页的 tag 不能删；这次没有页。）

## 5 又一轮取样：不是 runner 自己关的

加了第二处日志（`ScreeningAcpModelRunner.shutdown()` 会打印 `screening runner shutting down` + 在飞记录数），
重打打包态、再跑一次，读数：

```
[screening:model] screening record started ×2
[screening:model] screening record failed ×2   （仍是 Active session disposed / timedOut=false / ~40.2 s）
（没有出现 `screening runner shutting down`）
```

⇒ **runner 的 shutdown 没有被调用**，pass 并不是被自己的生命周期收掉的。那么 40 秒时那条会话是被
**ACP 运行时**那一侧 dispose 的（伴随 `[acp] agent process exit { signal: 'SIGTERM' }`）：最可能是
后端**代际切换**（`backendGeneration.supersede` → `connection-close-workflow.disconnect` 会
`disposeSessionCapabilities(activeSessionIds())`），或某个会话生命周期回收。

下一处该打日志的位置（还没做）：`connection-close-workflow.disconnect()` / `runtime` 的
`supersede` 入口，记录「谁要求关、当时的 generation、在飞会话数」。那是这条链的最后一环 ——
拿到它就能指名道姓地修，而不是继续从现象倒推。

## 6 再取样：连 ACP 的关闭工作流都没跑过

第三处日志（`connection-close-workflow.disconnect()` 入口 + `disposeSessionCapabilities` 前）重跑打包态：

```
[screening:model] screening record started ×2
[screening:model] screening record failed  ×2   （Active session disposed / ~40.2 s）
[acp] agent process exit { … }                  ← 有
（`acp disconnect requested` / `acp disposing session capabilities` —— 一条都没有）
```

⇒ 40 秒时**不是**应用主动做会话拆除：关闭工作流一次都没被调用。而 agent 进程确实退了
（`[acp] agent process exit`，且信号是 SIGTERM）。所以这一版把链路收到最后一层：

**screening 专用后端的 agent 进程在 ~40 s 被终止（信号级），会话随之失效** —— 终止不是来自
`disconnect()` 这条应用层路径，而是进程层面的清理/终止（`connection-resource-owner` 的
`shutdownSynchronously` 未被调用；`reapProcessTree` 只会在「已退出」之后收子进程）。

下一处唯一还没打日志的位置：真正执行 kill 的那一层（`process-tree` / `connection-resource-owner`
的 kill 点），记录「谁要求终止、当时的 reason」。这一步再走完，就能直接修而不用继续倒推。

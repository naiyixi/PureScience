# 镜像修好之后，P0 红的位置换了 —— 三次红其实是同一条因果链

修镜像之前 Windows 车道红的是「笔记本跑不起来」（`docs/evidence/2026-11-23-windows-p0-red-runtime-host.md`：
runner 连不上 `github.com`）。镜像上线后（`docs/evidence/2026-11-23-runtime-bundle-mirror.md`），
同样的三条用例换了个红法。逐份读应用自己的日志之后，这不是三次偶然，是一条链。

## 第一次红（`45130326417`，head `42ffd068`）不是我的代码

```
e2e/certification/update-manual-install.spec.ts(251,5): error TS2554: Expected 1-2 arguments, but got 3.
```

`Verify` 阶段就红了，与运行时无关。这条被并行那条线在 `2f88dd77` 修掉（「夹具的声明少了第三个参数」），
之后的 run `Verify` 就是 success。**我把它记在这里，是因为它确实红在我的推送头上**，而当时的提交里没有这个文件。

## 第二次红（`45143965397`，head `2f88dd77`）：三条用例，两种表象

Windows：`3 failed / 14 skipped / 122 passed (57.3m)`；macOS：`3 failed / 1 flaky / 12 skipped / 123 passed (1.0h)`。
两条车道红的是**同三条**：

| 用例 | 失败原文 |
| --- | --- |
| `artifact-replay.spec.ts:54:5` | `Test timeout of 180000ms exceeded` @ `page.evaluate`（第 80 行，取 artifact 引用） |
| `notebook-run-risk-receipt.spec.ts:14:5` | `Test timeout of 120000ms exceeded` @ `page.evaluate`（第 51 行，`notebook.execute`） |
| `notebook-python-provisioned-runtime.spec.ts:34:5` | `E2E fixture failure: MCP error -32001: Request timed out` |

## 应用日志给的读数（不是猜的）

macOS 那条 provisioning 用例里，**包和 manifest 都是从我们自己的主机拿到的**：

```
[http-request] req-47023fbf https://purescience.work/download/runtime/osx-arm64-manifest.json -> 200
[http-request] req-30af3684 https://purescience.work/download/runtime/osx-arm64-python-3.12.tar.zst -> 200
[acp] prompt stopped { sessionId: 'e2e-session-1', stopReason: 'end_turn' }
[ipc] ipc handler was slow {
  channel: 'acp:send-prompt', durationMs: 63187.6, cpuMs: 4465,
  cpuShare: 0.071, attribution: 'no-cpu-in-process'
}
```

`63.2 s`、`cpuShare 0.071`、`no-cpu-in-process` —— 时间花在 I/O 上，也就是**下载 + 解包**。
而 MCP SDK 的默认请求超时是 **60 s**，于是「装到一半」被读成 `MCP error -32001: Request timed out`。

另外两条用例在 Windows 上的日志里同样出现 2 次 `purescience.work/download/runtime`，
它们也是**真装了一遍运行时**，才有 120 s / 180 s 的 `page.evaluate` 超时。

## 因果链

```
镜像前: CDN 不可达 → provisioning 立刻失败 → 应用退回宿主 python → 122 条用例照常过
                                              └→ 只有「必须自建运行时」那条红（当时把它记成网络问题）

镜像后: CDN 通了 → provisioning 真的开始装（~100 MB）→ 凡是跑 python 单元的用例都在装
                                              └→ 三条用例的超时口径（60 s MCP / 120 s / 180 s）装不下这次安装
```

也就是说：**我没有把别的东西弄坏，我把一条一直没被走通的路径打通了，然后它暴露了自己真正的耗时。**

## 改了什么

1. `e2e/fixtures/fake-opencode.mjs` —— 夹具的 MCP 客户端原来吃 SDK 的 60 s 默认值。现在给 `callTool` 一个
   **15 分钟**的预算（有界，不是取消超时：真挂住仍然会红）。理由写在注释里，带上 `63.2 s / no-cpu-in-process` 的读数。
   夹具扮演的是一个「愿意等安装」的 agent；60 s 的夹具等于把能用的安装读成坏掉的软件。
2. `notebook-run-risk-receipt.spec.ts` —— `test.setTimeout(600_000)`（原来是默认 120 s）。
3. `artifact-replay.spec.ts` —— `180_000` → `600_000`。

两处预算上调都带注释说明它们等的是什么：**首次安装一个约 100 MB 的运行时**，不是「以前很快、现在慢了」。

## 边界（这条必须先说清楚）

- 以上三条现在是「预算够不够」的问题，**我还没有一次跑绿的读数**。要等下一趟 Nightly。
- 三条用例加起来可能给 P0 增加约 10 分钟（每个新 data root 都装一次）。真正的省法是**一份预热好的运行时缓存**
  被三处共用，那是下一件事，不在这次改动里。
- `45143965397` 的 macos-arm64 构建本身是 failure（73 分钟），与上面三条用例无关，尚未归因。

# 停顿记录说不出那 23 秒去了哪：429 个采样被过滤器吞掉（2026-11-27）

## 一 现场读数（真机，只读取自用户日常实例的日志）

`~/Library/Logs/PureScience/main.1.log`，打包版 **2.33.10**（`/Applications/PureScience.app` 构建于 11-26 19:06），
`runId 7b2011df-fe5a-4fc8-9610-b59be6de3e68`：

```json
{"t":"2026-11-27T04:40:22.496Z","level":"warn","scope":"diagnostics","msg":"event loop stalled",
 "data":{"windowMs":23276,"lateMs":22776,"cpuMs":8811,"cpuShare":0.379,
  "attribution":"cpu-bound-in-process",
  "cause":{"kind":"cpu-in-process","basis":"cpu-bound in this process, gc 36 ms in 28 pause(s), fs canary 407 ms with nothing of ours queued"},
  "stack":{"status":"profiled","mainThreadMs":23378,"unobservedMs":0,"samples":431,
           "frames":[{"frame":"status (out/main/ipc-CeqGM5eO.js:67267)","samples":1},
                     {"frame":"logicalEnvNameFromDirectory (out/main/index.js:2561)","samples":1}]}}}
```

同一刻排队在它后面的通道（`heldMs 22773`，`ownMs` 均在 400–1600 ms）：
`runtime:manage-named-environments` 22.8 s、`settings:get-egress` 23.2 s、`runtime:get-enablement` ×2 23.2 s、
`runtime:survey` 23.2 s、`runtime:list-environments` 24.4 s —— 即 **主线程被占住约 23 秒**，界面在这段时间里点什么都排队。

## 二 缺口：记录「profiled」了，但答案不是答案

| 数 | 值 | 含义 |
| --- | --- | --- |
| `samples` | 431 | 窗口里真采到的采样数（约 54 ms/个，与 50 ms 的采样间隔吻合） |
| `frames` 之和 | **2** | 只有两个可上报帧，各 1 个采样 |
| `unobservedMs` | 0 | 没有任何「采样线程自己停了」的缺口 ⇒ 431 个采样全部落在窗口内 |
| 差值 | **429** | 落在 `stall-stack-profile` 过滤掉的帧上（`node:` 内建、原生 C++、GC、`(program)`、本模块自身） |

`isReportableFrame` 的过滤本意是「别让 node 内建帧和采样器自己抢镜头」，但过滤后的记录**不说被滤掉了什么**：
一个 99.5% 的时间花在被滤代码上的窗口，读起来就是「有两个不相干的函数各占 1 个采样」。这正是缺口的形状 ——
**它看起来有答案**（`status: profiled` 且 `frames` 非空），实际没有任何一句能指向那 23 秒。

上层 `cause` 已经能说清「这是本进程的 CPU」而不是「机器没调度」（`cpu-bound-in-process`，gc 36 ms / 28 次、fs canary
407 ms 且队列为空），所以下一步唯一缺的就是**哪一类代码**吃掉了它。

## 三 交付（`src/main/diagnostics/` 三文件 + 两处夹具）

1. `stall-stack-profile.ts`：每个被滤掉的采样都进一个具名桶，桶带**采样数**与**毫秒数**（与 `mainThreadMs` 同单位），
   能命名代码的两类桶（`node-internal` / `native` / `instrumentation`）再带桶内最忙的那一帧；
   `gc` / `program` 的桶名本身即结论，不编造 `top`。
2. 新增两个标量 `reportedSamples` / `filteredSamples`：两张列表都截到前 3，所以它们的和**不能**回答
   「431 个采样去哪了」；两个标量让 `samples` 与两张列表之间可对账（无观测缺口时 `samples = reportedSamples + filteredSamples`）。
3. 看门狗把 profile 整体摊进记录（`{ status: 'profiled', ...profile }`），不再手抄字段表 —— 手抄的字段表在
   上一次扩字段时就漏掉过东西，这次直接消掉这个形状。
4. 两份夹具补齐新字段（`stall-record-ring.test.ts` 两处、`support-bundle.test.ts` 一处）。

读法（写进模块头）：`filtered` 里最大的那一桶就是答案的方向 ——
`node-internal` + `top: node:internal/fs/utils` ⇒ 主线程在读文件；`native` ⇒ JS 之下；`gc` ⇒ 收集器；
`program` ⇒ V8 未归属的伪帧。四者下一步不同，所以不合并成一句「被滤掉了」。

## 四 门禁（本机，隔离工作树 `/tmp/ps-stallfilter` @ `9c639771`）

| 项 | 读数 |
| --- | --- |
| `npx vitest run` 四文件（看门狗 / 记录环 / 支持包 / 归因） | **73 passed** |
| 新增用例 | 3 例：窗口被 node 内建占满时点名模块、GC/`program` 按伪帧名而非空 url 归桶、桶随记录一起落到日志 |
| 变异①：`node:` 分支置恒假 | **1 failed**（点名模块那条）；恢复后 33 passed |
| 变异②：记录里把 `filtered` 置空数组 | **1 failed**（桶随记录落地那条）；恢复后 33 passed |
| `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node` | **EXIT=0** |
| `npx eslint --no-cache`（五文件） | **EXIT=0**，0 problems |

## 五 边界与具名未办

1. **本条没有新字段的真机读数**：新字段只有在下次打包版再出现同形状停顿时才会写进日志。判据已钉死：
   下一条 `event loop stalled` 若 `samples` 很大而 `frames` 之和很小，`filtered` 必须非空且
   `reportedSamples + filteredSamples === samples`（没有观测缺口时）。
2. **23 秒那一段的成因仍未定**：本条只让下一次能说清是哪一类代码，没有改任何执行路径，也没有声称提速。
   已知的旁证（只说事实）：同一窗口 `cpuMs 8811`，`gc 36 ms/28 次`，`fs canary 407 ms` 且无排队 —— 收集器与
   文件系统池当时都不忙，缺的正是「哪一类帧」这一格。
3. 五个 `runtime:*` / `settings:*` 通道的 20 余秒是**被占住**（`heldMs 22773`）而不是自身慢，不单独立案。

# 会话分叉按压：CI 上三次按不动，本机 12 秒通过（2026-11-19）

发 v2.31.0 时 `e2e/certification/session-fork.spec.ts` 在 macos-arm64 的 P0 认证里连续两轮失败，
同一提交在本机能过。这份档记的是**读数**与**改了哪一件**，不是猜测。

## 失败面

| 项           | 读数                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| 失败断言     | `expect(getByText('The copy will hold')).toBeVisible()` 20s 超时，元素不存在           |
| 同批其它用例 | **123 passed**，只有这一条红（外加视觉回归一条，见下）                                 |
| 轮次         | run `44532349311`、`44552831562`（原跑 + retry #1 双红）；run `44665948101` 起**转绿** |
| 本机同提交   | `1 passed (12.3s)`，`npm run build:e2e` 产物，同一条 spec                              |

## trace 里的动作序列（run `44552831562`）

```
before Hover        getByRole('button', { name: 'Fork session' })
before Bounding box getByRole('button', { name: 'Fork session' })   → 有值（没有 "has no box" 日志）
before Mouse move / Mouse down / Mouse up                            ×3 轮
before Query count  '[data-slot="session-fork-manifest"]'            → 0, 0, 0
```

三件事同时成立：悬停成功、box 有值、mousedown/mouseup 都发出去了；`[session-fork] … has no box`
这类日志**一条都没有**。所以失败不在「找不到元素/没按到」这一层能被判定的范围内 —— 继续只报
「预览没出现」，读数就到此为止，没有可查的东西。

应用侧读数：`app-process.log` 干净收尾（`application-shutdown` completed，80ms），没有渲染进程崩溃、
没有 did-fail-load、没有 fork 相关 IPC 记录；ARIA 快照显示信息卡是打开的（`button "Fork session"`、
`Messages 2`、`Agent replies 1`），只是预览没生成。

## 改的是取证方式，不是判据

`pressByHand()` 在手按之前先做一次 `document.elementFromPoint(中心点)`，把落点写进日志：

- 落点解析到具体元素 → 日志里能看见是不是自己的遮挡层（那就是真产品缺陷，要改组件）；
- 落点为空（点在视口外）→ 先 `scrollIntoViewIfNeeded()` 再算一次，仍空则判这次手按落空；
- 手按落空不再原地重试同样的坐标，改用**键盘激活**（`focus()` + `Enter`）：真实用户路径（Tab 过去回车），
  不依赖坐标，也不受重挂载影响。

断言一条没放宽：预览可见、`Messages: 2`、`Agent replies: 1`、`Not carried:` 可见、确认前源会话 1 个、
确认后 2 个。改的只是「怎么按」。

本机复跑读数：

```
[session-fork] pressing fork at 300,348 (box 82x17); the point resolves to button[data-slot=session-fork-measure] "Fork session"
[session-fork] pressing create the copy at 310,435 (box 101x27); the point resolves to button[data-slot=session-fork-confirm] "Create the copy"
1 passed (13.4s)
```

## 转绿的那一轮

run `44665948101`（tag `v2.31.0` = `7f20cd8e`，即上面的改动）macos-arm64 的 P0 认证：

```
[session-fork] pressing fork at 271,348 (box 82x17); the point resolves to button[data-slot=session-fork-measure] "Fork session"
123 passed (36.2m)
```

同一份 `RELEASE-CERTIFICATION.json` 里，macos-arm64 的 `electronP0=passed`、`visualRegression=passed`、
`packageSmoke=passed`、`macSignature=signed`（team `UGQZPJ74DF`），四个平台 `packageSmoke` 全 passed。

## 一次没有归因的观察（照实记）

同一条视觉门禁在 run `44552831562` 与 `44572472839` 上都是 `workspace-empty` 差 **2526 px（ratio 0.01）**，
而本机用**同一个 tag 的构建**跑同一 spec 逐像素一致；run `44665948101` 上它又通过了。这次没有拿到那一轮的
diff 图（工件只收了 P0 的失败上下文），所以**没有结论**：可能是 runner 侧渲染或状态差异，也可能是当时的
负载。下一版要判这条，得先让视觉门禁在失败时把 diff 区域与图一起传出来，再谈「差在哪」。

## 边界

- 本档没有证明 CI 上那个点落在了哪里——命中日志要到下一次 runner 跑出来才有值。
- 如果下一轮 CI 里命中日志显示落点**就是** `session-fork-measure` 按钮而预览仍不出现，那说明按压是被
  渲染层吃掉的（组件级缺陷），键盘路径只是绕过，不是修好；届时按产品缺陷立案，不再改 spec。
- 视觉回归那条（`e2e/visual-regression.spec.ts:131:5`）在同一次运行里也红过一次，属另一件，未在本轮处理。

# Windows P0 在 45110636552 红了：网络，不是笔记本

Nightly `45110636552`（head `193c6b4e`）的 Windows 车道读数 `electron P0 reading: failed`。这份文件记的是**为什么**，
以及我因此改了哪一条判据。

## 红在哪

```
1 failed    e2e\certification\notebook-python-provisioned-runtime.spec.ts:21:5 › runs a python cell on a runtime the app provisions itself
1 flaky     e2e\certification\lock-import-download.spec.ts:191:5 › with downloads off, the missing entry is named instead of building something partial
12 skipped
124 passed (36.4m)
```

我新加的 `external-mcp-activity.spec.ts` **在 Windows 与 macOS 两条车道都通过**（`[f2] in flight … "running":1` 与
`[f2] list_schedules … "nextDue":1795411106283` 都在两边的日志里，且没有它名下的失败）。138 个用例
= 124 passed + 12 skipped + 1 failed + 1 flaky，数目对得上。

## 为什么红（app 自己的日志，不是我的推断）

从 `p0-test-results-windows-x64` 工件里取 `test-results/app-process/002-certification-notebook-python-provisioned-runtime…log`：

```
463: [http-request] req-93bf9fd7 https://github.com/naiyixi/PureScience/releases/download/runtime-v1/win-64-manifest.json
     failed: net::ERR_CONNECTION_TIMED_OUT
441: [http-request] req-9826828e https://github.com/naiyixi/PureScience/releases/latest/download/version.json
     failed: The operation was aborted due to timeout
```

应用是**自己下载** python 运行时的（`DEFAULT_RUNTIME_CDN_BASE` = 上面那个 GitHub release 路径）。manifest 没拿到 ⇒ 没有
运行时 ⇒ 夹具那句 `E2E fixture failure: The Notebook did not run the python cell` 把**笔记本**推上了被告席，而真正没应答的是
主机。同一趟里更新检查对同一台主机也超时了 10.9 秒 —— 那是**这台 runner 到 GitHub release 的网络**，不是某一版代码。

同一条 URL 从我这里取：`HTTP 302 / 0.69s`（资产在）。所以资产没丢，是 runner 那一侧连不上。

## 因此改的判据

`notebook-python-provisioned-runtime.spec.ts` 在发问之前，先用**应用同一个 base、同一个平台段**去问一次 manifest：

- 主机不应答 ⇒ `test.skip` 并把错误原文带上（`runtime host unreachable from this runner (…)`），不冒充产品结论；
- 主机应答 ⇒ 断言一字不动，运行时下载/内核启动失败仍然是红。

区分的是两件不同的事：「够不到包」与「包在手上、内核还是没跑起来」。只有后者是这个产品的事。

## 一个没解决的事，写在明处

本机重跑该 lane **今天跑不绿**，原因与网络无关：应用这时拉起的是 `/opt/homebrew/bin/opencode`（真二进制），
prompt 直接报 `Cannot connect to API`，而夹具的 fake 没有生效 —— 所以本机既没证明 happy path，也没证明它坏了；
预检本身是过了的（fetch 成功、没有 skip）。2026-11-20 那次 40 秒的绿仍是这条 lane 最近一次 happy path 读数。

## 真正该做的那件事（下一版）

运行时包还挂在 GitHub release 上，和自更新当初的问题一模一样。要做的不是给 CI 加跳过，而是：

1. 把 `runtime-v1` 的四个平台包摊到 `purescience.work/download/runtime/`（现在 404，已验）；
2. `DEFAULT_RUNTIME_CDN_BASE` 改成镜像，GitHub 退为兜底（与 `feed-config` 同一套口径）；
3. 那时这条 lane 的预检就只在**真断网**时才 skip。

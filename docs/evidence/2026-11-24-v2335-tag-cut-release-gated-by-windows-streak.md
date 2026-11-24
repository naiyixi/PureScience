# v2.33.5 打好了 tag，但发版闸门没给过 —— 卡在「Windows 连续三趟」

## 已经成立的部分

`aedb1337` 那一趟是本项目第一次同时拿到这些读数：

```
Nightly 45329816080        → success（七个作业，含 publish）
Windows Full Test 45329815962 → success
macOS arm64：Run P0 Electron certification → success
            Enforce the macOS Developer ID signature gate → success
            Enforce platform certification → success
```

于是 `1034c8c7` 里把 CHANGELOG 与双语横幅的结论改成真的那一趟，并按仓库既有口径打了 `v2.33.5`、
main 与 tag 同一次推送。tag 有了，release 没发出去。

## 闸门读到的是什么

Release 赛道 `45339548687`：

```
failure  Release preflight
skipped  build / publish / notarize-mac / windows-upgrade-smoke
release page: not found
```

preflight 的原文只有一行有用：

```
windows gate streak: 1/3 (not yet)
```

判据出自 `scripts/windows-gate-streak.mjs`，2026-11-22 拍板：单位是**Nightly 里 windows job 的读数**、
不是整趟 run；被取消或没跑到 windows job 的 run 跳过（既不算绿也不算红）；读到一次失败即归零；
`not-applicable` 也归零。脚本自己打印的账是：

```
credited: 45329816080
skipped:  45326425150 — no windows job
skipped:  45318235934 — reading=failed
```

也就是说：**只有一趟被记进连续数**。前面几趟里有的被我后续推送顶掉（cancelled ⇒ 跳过），有的
windows 读数是 failed（`45318235934`，那一趟红在 macOS P0，但 Windows 侧同样没给出绿读数）。
这不是闸门过严，是它按设计只认「连续三趟真绿」。

另外一点值得记住：Nightly 的 `paths-ignore` 里有 `**/*.md` 与 `docs/**`，所以纯文档提交**不会**产生
一趟 Nightly —— `1034c8c7`（只改 CHANGELOG/README）就没有贡献任何读数，想靠文档提交攒连续数是不可能的。

## 这次没有做的事（以及为什么）

- **没有把闸门调松，也没有重跑 preflight 指望它变绿**。preflight 不是偶发红，它报的是真实计数；
  调松闸门等于用「0 次 failure」这类最弱判据替代真读数。
- **没有为了让计数变好看而推空提交**。连续数的单位是 job 读数，空提交只会把一趟真跑挤掉。
- **没有把 `hermes` 框架半接进去**。查过 `AgentFrameworkId` 的落点：`registry.ts`、`preflight.ts`、
  `environment-check.ts` 三处是编译期强制的，但真正的工作量在 `prepareModelConfig` —— 要把应用侧的
  provider 翻译成 Hermes 的配置形状，并且必须真跑一次 `hermes acp` 握手才算完成。既然没跑过，就不动
  那个联合类型：半接进去的框架等于给用户一个点了会失败的按钮。
- 顺带确认：`ReportErrorDialog.tsx` 里那条 `docs.github.com` 外链已经不在源码里（`grep github.com` 零命中），
  去 GitHub 化这条没有残留。

## 怎么解开

需要两趟**带代码改动**的 Nightly，且每趟的 windows job 都是 success（`e94664cf` 已经是一趟，等它的读数）。
凑够三趟后再发版：`gh workflow run release.yml -f release_tag=v2.33.5`（tag 已在，无需重建；release 页
尚不存在，所以按「无页才删 tag」的规矩，这个 tag 可以留着直接复用）。

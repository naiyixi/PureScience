# macOS 升级演练：从「打 tag 就开始等」改成「发布事件才起跑」

## 一 现象（现取读数）

v2.33.6 发布后 `macOS Upgrade Smoke`（run `45471232479`）红在 `Wait for the mirror to serve the release`，
日志最后一行逐字：

```
[237] the mirror still says 2.33.5 (waiting for 2.33.6, 14403s of 14400s)
::error::the mirror did not offer 2.33.6 with both mac zips within 240 minutes (last reading: 2.33.5)
```

同一提交的 `Release` run 是 **success**，页与 17 件资产都落地（`RELEASE-CERTIFICATION.json` 的
`sourceSha = 3f654a7e…` = `git rev-parse 'v2.33.6^{commit}'`）。也就是说：**发布是健康的，红的是这条演练的时钟。**

## 二 定因：预算撞的是「Release 车道排队」，不是镜像慢

| 时刻（Z） | 事件 |
| --- | --- |
| 19:32:10 | tag 推上去，`Release` run 创建；`macOS Upgrade Smoke` 同秒起跑并开始等镜像 |
| 22:04:07 | `Release preflight` **才**开始（run 创建后 **2 小时 32 分**，此前在等第一个 runner） |
| 22:23:54 | `build / Verify` success |
| 23:33:04 | `build / Build macos-arm64` success（其余三平台 22:29–23:21 完成） |
| 23:40:03 | 两份 mac 公证 + staple 完成 |
| 23:41:25 | `publish` 建页（`published_at`），23:41:30 完成 ⇒ **tag → 资产 4 小时 09 分** |
| 23:32:17 | 演练的 240 分钟预算用尽（比资产落地早 **9 分钟**） |

镜像侧是正常的：服务器 `purescience-sync.log` 在 `08:00 CST (00:00Z)` 那趟就看到
`latest=v2.33.6 not complete — mirroring`，随后按 ~1.2 MB/s 逐件取回。

所以老账里「把 45 分钟抬到覆盖 tag→资产→sync」这条修法（§二百〇六 §三）**只解决了一半**：
45 → 240 分钟仍然输给「runner 排队 2.5 小时」这种不受本仓控制的方差。本轮把起跑点换掉，而不是再抬一次数字。

## 三 改法

| 文件 | 内容 |
| --- | --- |
| `.github/workflows/macos-upgrade-smoke.yml` | 触发从 `push: tags: v*` 换成 `release: types: [published]`（资产在这一刻已经存在）；`Resolve the pair under test` 的 tag 车道分支改成 `EVENT_NAME = push \| release`，`REF_NAME` 取 `github.event.release.tag_name` 并回落到 `github.ref_name`；**新增具名跳过**：tag 不是 `x.y.z` 时 `::notice::Nothing to drill: '<tag>' is not an x.y.z release tag` 并输出空 `previous_tag`（nightly 预发布也发 `published` 事件，但它不是版本）；`WAIT_FOR_FEED` 与 arch 矩阵表达式同步把 `release` 当自动车道（否则会在自动车道上悄悄不等待、且只打一个架构） |
| `scripts/ci/macos-upgrade-smoke-workflow.test.ts` | 两条新用例：①触发必须是 `release: published` 且**不得**再有 `push`；②解析步骤必须认 `release` 事件、取 `github.event.release.tag_name`、并对非 `x.y.z` tag 具名跳过。原 `WAIT_FOR_FEED` 那条补上 `release` 分支的断言（只增不减） |

预算仍是 240 分钟：现在它只覆盖「镜像 sync（每 30 分钟一次）+ 传输」，是余量而不是构建预算。

## 四 边界（具名）

1. **本轮没有新的一次真机升级读数**：v2.33.6 这趟演练在等镜像阶段就被预算切断，drill 作业 `skipped`。
   下一次 `release: published` 才是这条改法的第一个真读数（判据：`readiness` 在资产落地后起跑、
   `Upgrade macOS app in place (arm64/x64)` 真的执行并给出 `macOS upgrade reading:`）。
2. **v2.33.5 那趟的 drill 红因是另一件事**（run `45351488221`，两架构各红在 `update.download` 用尽 900 秒）：
   那条已经由既有提交修成「超时消息带字节与进度」（`withTimeout` 的 `describe`），本轮不动它，
   下一次红会点名字节数而不是只报「等了 120000 ms」。
3. **镜像站可用性不是本单元的证据**：本轮只核到 feed 当时仍 serve 2.33.5、服务器 sync 已开始取 2.33.6；
   feed 是否翻到 2.33.6 要等那一趟同步结束再读。

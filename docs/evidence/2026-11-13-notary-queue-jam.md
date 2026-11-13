# 公证队列是服务级积压（2026-11-13 16:52Z 读数）

`v2.27.0` 的 tag 驱动发布卡在公证上已经一整天。此前只能从失败作业的日志看出「45 分钟里状态一直是
`In Progress`」，但那条读数**分不开两种情况**：我们的包有问题，还是苹果的服务在排队。

本轮把这条读法做成了可运行的仪器（`.github/workflows/notary-status.yml`，`workflow_dispatch`，只读，
不构建不发布），并取了两次真实读数。

## 一 读数：8 笔提交，8 笔全是 `In Progress`

`notarytool history`（2026-11-13T16:52:55Z 读取，`gh run 43467128530`）：

| 提交时间 | 至读取时已等待 | 名称 | submission id | 状态 |
| --- | --- | --- | --- | --- |
| 11:32:48Z | 5h20m | zerolink-purescience-2.27.0-mac-x64.dmg | eed79267-fdb3-443e-b337-ef4cf3261f5b | In Progress |
| 11:34:02Z | 5h18m | zerolink-purescience-2.27.0-mac-arm64.dmg | f3358ee5-0d8a-461f-ad7c-65c252fa8c60 | In Progress |
| 13:24:38Z | 3h28m | zerolink-purescience-2.27.0-mac-arm64.dmg | d52b5630-8c12-44d2-be9a-1244da08500d | In Progress |
| 13:25:25Z | 3h27m | zerolink-purescience-2.27.0-mac-x64.dmg | 618fd26f-ba5f-41fd-9b7c-e1bf4af2856f | In Progress |
| 14:18:33Z | 2h34m | zerolink-purescience-2.27.0-mac-arm64.dmg | 8ac541a9-593b-4023-bd41-6e48f48cb5f4 | In Progress |
| 14:19:06Z | 2h33m | zerolink-purescience-2.27.0-mac-x64.dmg | 16d6bf61-940b-43a8-87bf-9ea85b8743a5 | In Progress |
| 15:58:27Z | 54m | probe.zip（另一支探针） | 99891708-fb39-47d4-9975-3c1d37605344 | In Progress |
| 16:41:06Z | 11m | probe.zip（本轮探针） | f8e72ad8-437a-460b-9d7b-7623203dccae | In Progress |

状态计数：`8 In Progress` —— **没有任何一笔拿到过 `Accepted` 或 `Invalid`**。

## 二 探针把两种解释分开了

探针是约 174 字节的**未签名** zip：苹果必须回 `Invalid`（内容未签名），正常一两分钟就该回。
本轮探针（`f8e72ad8…`，16:41:06Z 提交）轮询 10 分钟（40 次读数，`gh run 43465139244`），**全为
`In Progress`，没有判决**；15:58:27Z 那支探针在 16:52Z 复读时已经等了 54 分钟，同样没有判决。

⇒ **判决：不是我们的包**。一个必须被拒的包也拿不到判决，说明是排队本身。

「我们的包有问题」这种解释要求一个**明确的 `Invalid`** 加逐条 issue 原因（`notarytool log`），
而历史里连一笔 `Invalid` 都没有；四个平台的构建（含签名门与 P0 认证）在同一提交上全绿。

## 三 这也说明「首次 Developer ID 会被深度分析」不是全部原因

上一轮把长等待归到「首次提交被留作深度分析」。本轮读数让这个解释不够用：**同一 team 新提交的
一个未签名探针也卡在队列里**，它与我们的证书、entitlements、包内容都无关。能确证的只有一件事：
**这台队的服务在 16:52Z 时对整批提交都不出判决**。

## 四 边界（不许读成更强）

- 没有判决 ≠ 通过，也 ≠ 拒绝。台账里**任何一刻都不许写「公证已通过」**。
- 本读数只覆盖 `notarytool history` 保留的那 8 笔（返回的就是这些），不代表苹果内部没有更早的处理记录。
- 探针只回答「服务此刻是否作答」，不衡量我们的包将来会不会被拒。
- 这把仪器**不能**替代 `spctl -a -vvv` 的验收：那条读数只能在 Release 页出现、拿到真实 dmg 之后取。

## 五 复现

```
gh workflow run notary-status.yml --ref main
gh workflow run notary-status.yml --ref main -f submission_ids=<uuid>[,<uuid>]
gh workflow run notary-status.yml --ref main -f probe=true
```

arm64 的托管 runner 偶尔拿不到（GitHub 自己的注解是
`The job was not acquired by Runner of type hosted even after multiple attempts` +
`Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.`），
此时用 `-f runner=macos-15-intel`，读数与镜像无关。

四条分支（缺凭据 / 历史 / 指定 id / 探针超时与有判决）都在本机用替身 `xcrun` 跑过，见
`docs/mac-signing-setup.md` 的同名小节。

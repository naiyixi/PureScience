# Windows 真机安装/诊断/回滚：v2.33.2 → v2.33.3 的重新取证（2026-11-23）

## 为什么有这份文件

2026-11-22 回查「对标排期到底做到了没有」时发现：v3.3 三个单元（真机验证、安装诊断闭环、升级回滚）的
证据全部来自 **2026-11-19** 的三次 `windows-install-verify` 运行，而那个 workflow **只手动触发**、
输入默认值还写死 `v2.29.0 → v2.30.2`。产品此后走到 2.33.3，判据和它的夹具一起过期 —— 跑绿也只能证明
历史，不能证明现在。

修改（`0ac9bbd8`）：每周一自动跑一次，`old_version`/`new_version` 留空时**从仓库的 release 列表取最新两个**
（跳过 draft），dispatch 仍可钉版本。这样「装旧版 → 装成品 → 读它自己的 readiness → 把运行时装坏 → 一键重装
→ 覆盖升级 → 点名被删掉的运行时 → 回滚」这条链每周对着真产品重跑。

## 读数（run `45097349831`，head `0ac9bbd8`）

`resolved from the repository: v2.33.2 -> v2.33.3` —— 版本对来自仓库状态，不是默认值。

```
✓ installed-launcher-exists
✓ reads-readiness-and-runtimes
✓ broken-runtime-is-detected
✓ repair-restores-runtimes
✓ upgrade-changes-version
✓ upgrade-keeps-runtimes
✓ upgrade-names-a-deleted-runtime
✓ rollback-restores-the-previous-install
✓ healthy-update-is-left-alone
```

两条关键 JSON（job 日志原文）：

```json
{"outcome":"rolled-back","restoredFrom":"D:\\a\\_temp\\ps-winverify\\rollback-backup","version":"2.33.3.0","relaunched":true}
{"outcome":"healthy","version":"2.33.3.0"}
```

九步全 ✓，`install → runtimes → break → repair → upgrade → name-it: success`。证据产物
`windows-install-evidence`（`readiness-installed.json` / `readiness-broken.json` /
`readiness-after-repair.json` / `runtimes-after-upgrade.json` / `readiness-after-upgrade.json` /
`runtimes-after-upgrade-broken.json`）。

## 这份读数证明了什么、没证明什么

- **证明了**：在真实 Windows 11 x64 上，2.33.2 装得上、能起来并自己报 readiness/runtimes；把运行时装坏会被
  点名（`runtimes-after-upgrade-broken.json` 里 `stillListed` + 原因）；一键重装能恢复；覆盖升级到 2.33.3 后
  版本变了而运行时还在；装坏时会**真的回滚**（`restoredFrom` 是备份目录、`relaunched:true`），健康时不打扰。
- **没证明**：这不是从镜像 feed 升级（Windows 安装包是本地 setup.exe 覆盖安装），也**不是自动更新链路**的
  验证 —— 自动更新的 Windows 侧证据是 Release 里的 `windows-upgrade-smoke`（`v2.33.3` 那趟 success，
  certification artefact 4725 B）。
- **代价**：Windows runner 约 4 分钟真实使用（01:56:37 → 02:00:20），每周一次。

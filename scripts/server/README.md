# 官站下载目录的三个同步脚本

这三个脚本跑在 `purescience.work` 那台机器上（`/usr/local/bin/`），**不在任何 CI 里**，
所以源码在这里留一份 —— 服务器上的副本是部署产物，回滚或重建机器时从这里装回去：

```bash
scp scripts/server/purescience-*.sh root@<host>:/tmp/
ssh root@<host> 'install -m 0755 /tmp/purescience-{mirror,sync,versions}.sh /usr/local/bin/'
```

cron（每 30 分钟）：

```
*/30 * * * * /usr/local/bin/purescience-sync.sh >/dev/null 2>&1
```

## 各自做什么

| 脚本 | 职责 |
| --- | --- |
| `purescience-sync.sh` | 查 GitHub 最新 Release，没镜像完就跑 mirror，最后重算 `versions.json`。带 `flock`，并且发现有 `.part` 在 10 分钟内动过就不插队。 |
| `purescience-mirror.sh` | 把某个 tag 的资产拉到 `/var/www/purescience/downloads/<tag>/`，按发布页的 `SHA256SUMS.txt` 校验，把 GitHub 声明的尺寸记进 `.sizes.json`，全部过关才写 `.complete`。 |
| `purescience-versions.sh` | 扫描下载目录生成 `versions.json`。**只有完整的一版才会进 `latest` 与 `versions`**，不完整的进 `pending` 并带上缺哪些文件。 |

## 完整性闸门是被一次 404 抓出来的

v2.32.0 发布后，14:00 那次同步把 `latest` 设成了 v2.32.0，而它的 `.deb`（241 MB）还在下载 ——
页面上的 deb 链接点了是 404。两个缺陷叠在一起：

1. `sync.sh` 用「目录在 + `SHA256SUMS.txt` 在」判断镜像完成，而 `SHA256SUMS.txt` 是最先落盘的小文件，
   于是「还在下」被当成「已下完」，之后再也不会补那个文件；
2. `versions.sh` 只要求有 macOS 与 Windows 两件产品在，就认为这一版可以上页面。

现在：`.complete` 由 mirror 在「全部资产到齐 + 摘要与尺寸都过」之后才写；`versions.sh` 要求
`SHA256SUMS.txt` 列出的每个文件都在、没有 `*.part`、且尺寸与 `.sizes.json` 一致。

判据本身验过两个方向（`/tmp` 里造的合成树）：完整版进 `latest`；缺 deb 的一版和尺寸被截断的一版
都进 `pending`，并各自报出缺什么。

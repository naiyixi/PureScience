# 官网发布同步（服务器侧）

官网 `purescience.work` 的下载包来自 `/var/www/purescience/downloads/<tag>/`，页面本身**不写死版本号**：
它在加载时读 `/download/versions.json` 改写下载链接。所以新增一个版本只需要把包放进目录并重算清单。

## 三个脚本

| 脚本 | 装到服务器 | 作用 |
|---|---|---|
| `mirror-release.sh` | `/usr/local/bin/purescience-mirror.sh` | 按 GitHub Release 资产清单拉某个 tag 的全部文件，逐条按 `SHA256SUMS.txt` 校验 |
| `versions.sh` | `/usr/local/bin/purescience-versions.sh` | 扫描 downloads 目录，生成 `versions.json`（最新版、各平台文件名/字节数/链接、校验清单） |
| `sync.sh` | `/usr/local/bin/purescience-sync.sh` | 查最新 Release tag，缺就拉，然后重算清单；cron 每 30 分钟一次 |

## 安装

```bash
scp scripts/website/mirror-release.sh root@<host>:/usr/local/bin/purescience-mirror.sh
scp scripts/website/versions.sh      root@<host>:/usr/local/bin/purescience-versions.sh
scp scripts/website/sync.sh          root@<host>:/usr/local/bin/purescience-sync.sh
ssh root@<host> 'chmod +x /usr/local/bin/purescience-*.sh; \
  (crontab -l 2>/dev/null | grep -v purescience-sync; \
   echo "*/30 * * * * /usr/local/bin/purescience-sync.sh >/dev/null 2>&1") | crontab -'
```

## 为什么这样设计

- **直连 GitHub 只有 ~20 KB/s**，加速前缀（`ghfast.top`，实测 0.9–1.1 MB/s）优先，直连兜底；无论走哪条路，最终都以 `SHA256SUMS.txt` 为准。
- **清单只列至少有 Windows 与 macOS 产品的版本**：拉了一半的目录不会出现在页面上。
- **页面脚本只是改写链接**：JSON 拿不到时静态链接照旧可用，官网不会因为脚本失败而没有下载入口。

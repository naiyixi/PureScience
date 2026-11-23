# 运行时包有了自建镜像，第一跳最先问它

Windows P0 在 `45110636552` 红的那条 lane（`docs/evidence/2026-11-23-windows-p0-red-runtime-host.md`）暴露的是
同一个老问题：**产品在墙内依赖 GitHub release 下载**。自更新早就改走 `purescience.work/download/feed/`，运行时包没有。

## 先量，再改

| 路径 | 实测 | 结论 |
| --- | --- | --- |
| 部署机 → GitHub 对象存储 | 59 秒 711 KB（**11.8 KB/s**） | 服务器自己拉不动，镜像不能靠 cron |
| 部署机 → `gh-proxy.com` | 33 KB/s | 不能当主路 |
| 部署机 → `ghfast.top` | 378 KB/s | 只能兜底 |
| 本机（走 127.0.0.1:7897）→ GitHub | **8.4 MB/s** | 取包放在能到的地方做 |
| 本机 → 部署机（单流） | ~210 KB/s | 慢；四路并行 ~0.9 MB/s |
| 本机 → `purescience.work/download/runtime/` | **421 KB/s** | 比直连 GitHub 快 **19 倍**，这就是把自家主机排在第一跳的理由 |

所以镜像的工作方式是：**由能到 GitHub 的机器取，再推上去**，落 `scripts/fetch-runtime-bundle.sh` 与
`scripts/push-runtime-mirror.sh` 两条可复现的命令（后者逐个核对磁盘字节数与公网 `Content-Length`）。

## 盘先腾出来

11 个版本各 2.2 GB，`/var/www` 到了 **81%**。按「留最近三版」清掉 v2.27.0…v2.33.1：

```
回收 19,039 MB；40G 盘 81% → 31%（剩 26 GB）
versions.json 按磁盘重算：latest v2.33.4，3 个版本，pending 0
feed 仍指 2.33.4（latest-mac.yml 未动）
```

## 落了什么

`/var/www/purescience/downloads/runtime/` —— nginx `location ^~ /download/` 别名到 `downloads/`，所以公网是
`https://purescience.work/download/runtime/<file>`。第一批是 **manifest × 4 + 四个平台的 python 3.12**
（正是默认规格那一份，约 352 MB）。第一批 8 个文件逐个核过：公网 `HTTP 200` 且 `Content-Length` 等于 release 声明的字节数；Windows 那份
99,085,435 字节的 `sha256` 与本地副本逐位相同（`ae3916aa…`），不是「大小对了就算」。

其余 python 3.11/3.13 与 R 4.3/4.4（16 个文件，约 2.76 GB）在后台续推 —— 未镜像的文件在候选链里会
落空并继续问 origin/代理，所以「部分镜像」是优雅降级，不是错。

## 代码侧：两处顺序改了，并用 `via` 说出来

1. `source-mirrors.ts` 加一条规则：`github.com/naiyixi/PureScience/releases/download/runtime-v1/<file>`
   → `https://purescience.work/download/runtime/<file>`，且排在三方代理**之前**。
2. `VENDOR_MIRROR_HOSTS = ['purescience.work']`：**自己发布的主机可以先于 origin 被问**（中国首启以前要先把
   30 秒 manifest 超时耗在 github.com 上才有镜像机会），三方镜像仍然严格排在 origin 之后 —— 这正是摘要校验与
   顺序设计要限制的东西。`downloadWithMirrorFallback` 与 `fetchManifestText` 都按这个顺序走。
3. 只改精确的 `runtime-v1` 资产路径：嵌套路径、带 query 的 URL 一律不猜（会 404，看起来像故障），仍留给三方。

## 判据

- `source-mirrors.test.ts`：runtime 资产的候选顺序 = `purescience.work → gh-proxy → ghfast`；嵌套/带 query 不乱猜；
  下载侧 vendor 先问且 origin 未被调用；vendor 失败 → origin → 三方逐级落到 `ghfast.top`。
- `language-pack-manifest-mirror.test.ts`：origin 先赢（当 vendor 不在候选里）、vendor 先于 origin、非 2xx 也算不答、
  全灭时逐个点名主机与原因。
- 合跑 **40 passed**；`notebook` 目录 **1519 passed**；`tsc`/`eslint` 干净。

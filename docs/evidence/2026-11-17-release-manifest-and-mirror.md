# 发布链两处相邻缺口：AppImage 进不了清单 / 镜像工作流调用方式失效（执行器，2026-11-17）

> 来源：仓库 issue #20（2026-09-30 立案，随 v1.76.x 发版时发现）。本轮按「先核现状再动手」核对：
> 两处都**仍然成立**，且第一处有已发布产物作证。本档记症状、根因、改法、真实读数、变异自证与边界。

## 一 症状与取证（真实发布页，非推测）

### 1.1 清单里从来没有 AppImage

拉已发布版本自己的清单（产品与网站都读它）：

```
gh release download v2.27.0 -p version.json -O /tmp/vjson.json
downloads keys: ['linux-x64-deb', 'mac-arm64', 'mac-x64', 'win-x64']     ← 4 个，没有 linux-x64-appimage
```

同一发布页的资产名：

```
zerolink-purescience-2.27.0-linux-x86_64.AppImage
```

`scripts/generate-version-manifest.mjs` 的 `INSTALLERS` 那时写的是
`zerolink-purescience-${v}-linux-x64.AppImage`（`x64`）。文件名对不上 ⇒ 脚本走「未识别」分支只打一行
`warn: unrecognized release file …` 就跳过，**发布作业照旧绿**。

历史核对（都是 `x86_64`，从没有过 `-linux-x64.AppImage`）：`v1.75.0`、`v1.76.1`、`v1.80.0`、`v2.27.0`。

### 1.2 后果不止「少一个下载链接」

客户端 `src/shared/update.ts` 的 `selectDownload()` 有专门一支：linux 且清单里没有 deb 时回落到
`linux-x64-appimage`。生产者从不产出这个键 ⇒ **这条回落路径在生产里永远不可能命中**（只有单测用手搓
清单覆盖过它）。这与「门要的字面量必须取自生产者自己的枚举」是同一类错误的镜像：消费方认的键，生产者写不出来。

### 1.3 镜像工作流调用方式失效

`.github/workflows/mirror-to-website.yml` 的 `Generate version.json` 步骤此前是纯环境变量调用：

```yaml
run: |
  node scripts/generate-version-manifest.mjs      # 无参数
```

而脚本 `main()` 现在要求 argv 里有目录（无参数直接 `usage:` + exit 1），且已不再读取
`DIST_DIR` / `OUTPUT` / `CDN_BASE_URL` / `S3_PREFIX` ⇒ 这一步**必然退出 1**，整条 CDN 镜像路径产出为零。
连带第三处不一致：脚本把清单写进 `<dir>/version.json`，而下游 `aws s3 cp version.json` 与
`inject-feed-notes.mjs version.json` 读的是**仓库根**的那个路径。

## 二 改法

| 位置                                      | 改动                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/generate-version-manifest.mjs`   | `INSTALLERS['linux-x64-appimage']` 改成 `-linux-x86_64.AppImage`，并把「为什么是 x86_64 / 写错的后果是静默」写进注释                                                                                                                                   |
| 同上                                      | 新增 `resolveManifestOptions()`：位置参数仍是 `<dir> [version]`，新增 `--out` / `--cdn-base` / `--s3-prefix`（缺省分别回落 `OUTPUT` / `CDN_BASE_URL` / `S3_PREFIX`）。带值 flag 的值**不会被当成 version**（旧写法 `args.find(!startsWith('--'))` 会） |
| 同上                                      | 镜像模式（非 `--github`）**没有 base 就具名失败**：旧代码硬编码 GitHub URL 并在 prefix 为空时拼出 `…/download//releases/…`，等于给客户端一份指向不存在地址的清单                                                                                       |
| 同上                                      | `buildManifest` 的 URL 拼接在 prefix 为空时不再产生 `//`                                                                                                                                                                                               |
| `.github/workflows/mirror-to-website.yml` | 按新契约调用：`"$DIST_DIR" "$VERSION" --cdn-base "$CDN_BASE_URL" --s3-prefix "$S3_PREFIX" --out "$OUTPUT"`；`CDN_BASE_URL` 为空时先打三行具名原因再 `exit 1`（不写指向空地址的清单）                                                                   |

`release.yml` 的 `--github` 调用方式与产物形状**未变**（这一步没碰）。

## 三 真实读数（真发布资产 + 真脚本 + 产品自己的解析器）

下载 v2.27.0 全部资产到 `/tmp/rel2270`（19 个资产，1.7 GB）后跑两种模式：

```
node scripts/generate-version-manifest.mjs /tmp/rel2270 2.27.0 --github
==> /tmp/rel2270/version.json: version=2.27.0 platforms=linux-x64-appimage,mac-arm64,mac-x64,win-x64,linux-x64-deb

node scripts/generate-version-manifest.mjs /tmp/rel2270 2.27.0 \
  --cdn-base https://cdn.example.com --s3-prefix purescience --out /tmp/rel2270-out/version.json
==> /tmp/rel2270-out/version.json: version=2.27.0 platforms=linux-x64-appimage,mac-arm64,mac-x64,win-x64,linux-x64-deb
```

**逐条对账**（清单里的 sha256 / size ↔ 真文件字节 ↔ release 自己的 `SHA256SUMS.txt` ↔ GitHub API 的资
产 size，四个来源）：

```
PROBE ok key=linux-x64-appimage file=…-linux-x86_64.AppImage bytes=308696035 manifest.sha256=b122ae4f541b computed=b122ae4f541b sums.txt=b122ae4f541b
PROBE ok key=mac-arm64   … bytes=285576982  sha=c90065bc6756
PROBE ok key=mac-x64     … bytes=301905769  sha=630858c39663
PROBE ok key=win-x64     … bytes=235778118  sha=8469e4ed16c0
PROBE ok key=linux-x64-deb … bytes=231728524 sha=5d7449bb6ef1
PROBE keys=5 failures=0
```

`gh api …/releases/tags/v2.27.0` 报的五个 size 与上面逐字相同（308696035 / 285576982 / 301905769 /
235778118 / 231728524）。

**产品自己的回落路径**（`node --experimental-strip-types` 直接 import `src/shared/update.ts`）：

```
PROBE selectDownload(linux, deb present) -> zerolink-purescience_2.27.0_amd64.deb
PROBE selectDownload(linux, deb absent)  -> zerolink-purescience-2.27.0-linux-x86_64.AppImage
PROBE verdict=PASS
```

第二行就是修复前**永远走不到**的那一支。镜像模式的 URL 形状（`--s3-prefix purescience`）：
`https://cdn.example.com/purescience/releases/2.27.0/<file>`。

## 四 变异自证（证明用例真的在守这两件事）

| 变异                                                       | 结果                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 把 `INSTALLERS` 里 AppImage 名字退回 `-linux-x64.AppImage` | 4 条用例红：`maps every installer…`、`keys the linux AppImage by the name electron-builder actually writes`、`produces a manifest the client can fall back…`、CLI 的镜像那一条 |
| 把工作流里的 `--s3-prefix/--out` 去掉（只留 `--cdn-base`） | 1 条红：`passes the artifacts dir, the version and the mirror url flags to the CLI`                                                                                            |

第二组还顺带证明：YAML 断言读的是真实工作流文件（`process.cwd()` 下的 `.github/workflows/`），不是抄一份进来。

## 五 门禁（本机实跑）

| 环                                                         | 读数                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `npx vitest run scripts/generate-version-manifest.test.ts` | **1 file / 42 passed**（本笔 +11）                            |
| `npx vitest run scripts/ --maxWorkers=4`                   | **43 files passed / 13 skipped**；**557 passed / 17 skipped** |
| `npx eslint --no-cache`（两个文件）                        | 0 error / 0 warning                                           |
| `npx prettier --check`（两个文件）                         | 通过（只改到本笔新增行）                                      |
| `npm run typecheck:node`（`--composite false`）            | 0（`NODE_OPTIONS=--max-old-space-size=8192`）                 |
| `npm run typecheck:web`                                    | 0                                                             |

## 六 边界（不许读成更强）

1. **「清单里有 AppImage」尚未在真实发布页上确认**：本轮证明的是「同一份真实资产喂给修好的脚本，会产出
   这个键且摘要素材逐条对得上」。要拿到发布页版读数，得等下一次发版（`version.json` 里应出现
   `linux-x64-appimage`，且发布日志里不再有那条 `warn: unrecognized release file …AppImage`）。
2. **镜像工作流没有实跑**：仓库变量 `CDN_BASE_URL` / `S3_PREFIX` 与 S3 凭据（`S3_ACCESS_KEY_ID` 等）
   **都不存在** ⇒ 网站镜像尚未启用，手动派发会在第一步就按新的具名原因失败（这正是设计意图），且即便
   越过这步也没有可写的桶。本轮只证明了「这一步的命令行按新契约能产出正确清单」（本地按工作流原样的
   参数跑通）。启用前置 = 建站侧提供 CDN 基址、桶与前缀，然后把三个变量/凭据配上。
3. 没有界面/数据路径改动 ⇒ 没有窗口读数；本单元是发布链工具，验收层就是「真资产 → 真清单 → 真解析器」。

## 七 追踪

- issue #20 已按本档读数追加评论（第 1 条：根因与修复；第 2 条：镜像未启用的具名前置）。
- 第 1 条的「下一版发布后确认」与第 2 条的「启用后派发一次」留在 issue 里，未关单。

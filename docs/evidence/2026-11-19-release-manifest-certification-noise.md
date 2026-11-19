# 发布清单：AppImage 条目已核验，认证证据不再冒充「unrecognized」

日期：2026-11-19（执行器轮次 §三百五十七）
对象：issue #20 两处发布链缺口 + 发版日志里一路没人读的那四行 warn
只读取证：真实发布资产（v2.30.2）与本机伪造的产物目录；未重启任何实例、未跑构建。

## 一 AppImage 条目：真实发版上已核验（缺口下半截结案）

issue #20 第 1 条的验收判据是「下一版发布后 `version.json` 的 `platforms` 含 AppImage 条目」。取法：

```
gh release download v2.30.2 -p version.json -R naiyixi/PureScience
```

读数（`downloads` 的键与 URL 末段）：

| 键 | 文件名 |
| --- | --- |
| `linux-x64-appimage` | `zerolink-purescience-2.30.2-linux-x86_64.AppImage` |
| `linux-x64-deb` | `zerolink-purescience_2.30.2_amd64.deb` |
| `mac-arm64` / `mac-x64` | `…-mac-arm64.dmg` / `…-mac-x64.dmg` |
| `win-x64` | `…-win-x64-setup.exe` |

五条齐，AppImage 在里面。发布作业自己的汇总行（run `44216634387`，publish job `134539767731`）：

```
==> artifacts/version.json: version=2.30.2 platforms=linux-x64-appimage,mac-arm64,mac-x64,win-x64,linux-x64-deb
```

即闸门是在**产物**上断言的性质，不是「作业绿了所以大概没问题」。

## 二 镜像路径（argv 形态）：本机实跑产出可用清单

同一个脚本的镜像模式（`mirror-to-website.yml` 的调用形态）在伪造的产物目录上真跑：

```
node scripts/generate-version-manifest.mjs /tmp/vmdist 2.30.2 \
  --cdn-base https://cdn.example.com --s3-prefix purescience --out /tmp/vmdist/mirror.json
```

目录里放了五个安装件、三个 zip、五个 electron-updater feed 文件、`SHA256SUMS.txt`（真算的 sha256）、
`RELEASE-CERTIFICATION.json` 与四个 `certification-*.json`。读数：exit 0，汇总行同样是五平台，
下载 URL 形如 `https://cdn.example.com/purescience/releases/2.30.2/<file>`，size/sha256 逐个对得上，
**零 warn**。

## 三 本轮修的缺陷：认证证据被当成「unrecognized release file」

上面那条 publish 日志里还有四行：

```
warn: unrecognized release file certification-linux-x64.json
warn: unrecognized release file certification-macos-arm64.json
warn: unrecognized release file certification-macos-x64.json
warn: unrecognized release file certification-windows-x64.json
```

这四个文件是发布作业自己产出的**按平台认证证据**（`scripts/ci/release-certification-evidence.mjs`），
既不进包也不进清单，所以它们落进了「认不出来的文件」这条分支 —— 每次发布四个，无害。

问题不在噪声本身：**同一条分支是「安装件名字对不上」唯一的信号**，而 AppImage 那一格正是
「发布日志里一直有 warn、没人再读」才跨了十几个版本没被发现的。四行例行 warn 把这条信号稀释成了背景。

修法（`scripts/generate-version-manifest.mjs`）：把 `certification-<平台>.json` 认作已知的非安装件，
与 `RELEASE-CERTIFICATION.json` 同等处理；**其余认不出来的文件照旧 warn**。

变异证明门没被削弱（同一目录另加两个真错名文件后重跑）：

```
warn: unrecognized release file certification-.json
warn: unrecognized release file mystery-setup.exe
==> …: version=2.30.2 platforms=linux-x64-appimage,mac-arm64,mac-x64,win-x64,linux-x64-deb
```

`certification-.json`（后缀为空）与 `mystery-setup.exe` 都仍然报，清单仍是五条。

## 四 门禁（本机实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run scripts/generate-version-manifest.test.ts` | 1 file / **44 passed**（新增两条：认证证据静默、形似认证证据仍 warn） |
| `npx eslint --no-cache`（两个改动文件） | 0 error / 0 warning |
| 脚本 CLI（伪造产物目录，镜像模式） | exit 0，五平台，零 warn |

## 五 边界（明确没做的）

1. **镜像工作流本身没有手动触发跑过**：它读仓库变量 `CDN_BASE_URL` / `S3_PREFIX`，两者为空时脚本
   开头就打印 `mirror not enabled: CDN_BASE_URL is unset …` 并非零退出 —— 这是「明确未启用」，
   不是静默坏掉，本次没有为了取绿去填假变量。
2. **AppImage 的那半截只到清单为止**：清单里出现 URL 不等于 CDN 上真有那份文件（镜像未启用）。
   GitHub Releases 侧的那份是真资产，已在上表逐字对上。
3. 本轮的修法不改任何安装件命名，也不碰 workflow 文件（`.github/workflows/**` 属受保护面）。

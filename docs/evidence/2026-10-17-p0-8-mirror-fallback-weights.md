# P0-8 后半：带摘要的权重获取接上镜像回退 + 停滞判定（2026-10-17）

> 前两片已交付：失败族词表 + 代理具名作答（`60333ac9`）、内容下载的镜像表与回退（`d4de3915` / `3476e2bd`，
> 消费方是 language-pack 与进度文案里的 `via`）。**本片补的是「本机唯一真正会下大文件的那条产品路径」**：
> 解析模型权重（随包清单里 298.7 MB 那一条）此前走的是**单次裸 fetch、没有重试、没有停滞判定、没有镜像**，
> 而它恰恰是**手里有发布方摘要**的那条路 —— 摘要正是允许回退的全部理由。

## 一 候选配对：逐对实测（本机，2026-10-17）

**同一性用「同一份发布资产、两种取法、逐字符比 sha256」**（不是按组织归属推理）。探针资产
= `v2.5.1/version.json`（10,560 字节，与 298.7 MB 权重同一个 release-asset 主机族）：

| 端点 | HTTP | 字节 | 耗时 | sha256 |
|---|---|---|---|---|
| 原始端点 `github.com/.../releases/download/v2.5.1/version.json`（`-L` 直连） | 200 | 10,560 | 1.11 s | `21c6c98b…cb722` |
| 原始端点（经本机代理 7897） | 200 | 10,560 | 2.48 s | `21c6c98b…cb722` |
| `gh-proxy.com/https://github.com/...` | 200 | 10,560 | 1.09 s | **同** |
| `ghfast.top/https://github.com/...` | 200 | 10,560 | 0.84 s | **同** |
| `ghproxy.net/https://github.com/...` | 200 | 10,560 | 2.26 s | 同（**但吞吐被否决**，见下） |
| `hub.gitmirror.com/https://github.com/...` | — | 0 | — | **DNS 不解析**（`Could not resolve host`） |
| `gh.llkk.cc/https://github.com/...` | — | 0 | 25.01 s | **连接超时** |

**吞吐**（同一份 298.7 MB 资产的 2 MB Range，`curl -r 0-2097151`，同机同刻）：

| 路径 | 2 MB 用时 | 吞吐 |
|---|---|---|
| 直连（无代理） | 14.77 s | **138.7 KB/s** |
| 经本机代理 | 2.74 s | 747.8 KB/s |
| `ghfast.top` | 3.82 s | 536.1 KB/s |
| `gh-proxy.com` | 1.47 s | **1394.2 KB/s** |
| `ghproxy.net` | 30 s 只收到 994,691 B | **32.4 KB/s（超时）** ⇒ 不进表 |

⇒ 入表的两条：**`gh-proxy.com`（首选）、`ghfast.top`（次选）**；三条被否决的写进源码注释，**不进表**。

**一条仪器坑（已当场纠正）**：第一版探针在循环里复用同一个输出文件、失败时不删旧文件，于是
`hub.gitmirror.com`（DNS 失败、0 字节）与 `gh.llkk.cc`（超时、0 字节）两行**打印的是上一轮遗留文件的 sha256**，
读起来像「它们也拿到了同样的字节」。**每轮先删输出文件**（与「换源前先删 `.part`」是同一条纪律）。
同一坑的第二面：原始端点第一次没带 `-L`，302 的 0 字节被算成 `e3b0c442…`（空串的 sha256）——**必须跟随重定向**。

## 二 代码（本片）

| 位置 | 改动 |
|---|---|
| `src/main/net/source-mirrors.ts` | 规则表支持「一条规则给多个候选」（`rewrite: URL => string[]`）；新增 `github.com` 规则，**只认 `/releases/download/` 形态**，且**带查询串 / 带用户名的 URL 一律不给候选**（拒绝猜）；新增 `streamWithMirrorFallback`：**流式落地**这一层的回退，原端点优先、**换源前删掉原端点的残留字节**、无摘要一律不试候选 |
| `src/main/engines/model-weight-cache.ts` | `WeightStreamer` 增加可选 `{ expectedSha256 }` 入参并返回**实际来源**（`'origin'` 或镜像宿主）；`downloadModelWeightsStreaming` 把发布方摘要传进去、把 `via` 带回结果；`streamUrlToFile` 改为经 `streamWithMirrorFallback`；新增 `createStallGuard`（**逐块重置**的停滞判定，30 s 无字节即判失败）并接进两条栈（Electron 的 Chromium 与 Node 的 fetch） |
| `src/main/engines/local-parsing-models.ts` | 结果文案：来源不是 origin 时写「（经镜像 `<host>`）」，与既有 `Downloaded <file> from <host>` 同一口径，**不新增 i18n 键** |

**为什么必须有停滞判定**：九天真机日志里的下载失败多数不是「报错」，而是**连接不结束**。没有停滞判定，
「原端点失败」这条路在**最常见的那种失败**上永远走不到 ⇒ 镜像回退等于装饰。判定写成流里的一道阶段
（而不是整请求超时）：298.7 MB 本来就要几分钟，**时钟必须随每一块重置，不能只跑一次**。

**为什么摘要入参是安全边界而不是装饰**：带摘要，镜像若给了别的字节，落地文件的 sha256 对不上 ⇒ 与原始端点
**一样响亮地失败**（`checksum-mismatch` + 临时文件删除）；不带摘要，候选一个都不试。

## 三 真机读数（真实网络，两条都是产品路径）

探针文件 `src/main/net/zz-probe-*.test.ts`（**跑完即删，未入库**；删除后 `ls src/main/net/zz-probe-*` 计数回 0）。
Digest 由独立的 `curl … | shasum -a 256` 测得，不由被测模块自己算。

```
PROBE origin   via=gh-proxy.com sha=21c6c98b32934144f7beb8864ef0b928702d1e68c35f284988f44a5bce8cb722 match=true
PROBE fallback via=gh-proxy.com sha=21c6c98b32934144f7beb8864ef0b928702d1e68c35f284988f44a5bce8cb722 match=true
```

- **第一行不是注入的**：真 URL 原样调产品路径 `streamUrlToFile`，原端点自己失败、**自动回退**到 `gh-proxy.com`，
  落地字节与独立测得的摘要逐字符相同 ⇒ 回退那一跳在真网络上成立（不是「候选端点可达」那种弱证据）。
- **原端点为什么失败（具名）**：同机同时刻 `node fetch`（undici，不读系统代理）报
  `TypeError: fetch failed … cause=UND_ERR_CONNECT_TIMEOUT (github.com:443, timeout: 10000ms)` ——
  10.5 s 后连接超时；而 `curl` 直连同一 URL 是 200。⇒ **两种栈在同一条链路上结论不同**，
  这正是本仓把 Electron 内那条路走 Chromium（吃设置里的代理）、并把停滞/回退放在流这一层的理由。
- 第二行是**确定性触达回退分支**的对照（把原端点那一跳注入失败，镜像那一跳与摘要仍是真网络）。

## 四 边界（不许读成更强）

1. **只对带摘要的下载生效**。科学数据源的 API（PubMed / RCSB 那两族）**没有可校验的摘要** ⇒ 它们不适用回退，
   仍按**具名失败**报错（那是 `60333ac9` 已交付的那一半，也是本片**没有**去动的那一半）。
2. **不从「地区」预判换源**：固定形态是「先试原端点、失败才换源」。同一条链路在不同时刻红绿并存
   （2026-10-11 记过 `raw.githubusercontent.com` 的间歇性超时），所以「它不可用」不是可以写下的结论。
3. **镜像宿主是第三方**，可用性会变（`ghproxy.net` 今天就被吞吐否决）。表里只保留当天实测可用的两条，
   且每次下载都由摘要兜底；宿主换了只需改一处常量。
4. **`via` 只到「本次结果的文案 + 结果字段」**，还没有进持久溯源（env 记录里的来源字段属另一个单元，
   `blocked-by` = schema 与迁移口径）。
5. **298.7 MB 那一条的整文件回退读数**见下（若本机网络在窗口内允许）；否则如实记为未取，
   不拿 10 KB 那条替代。

## 五 298.7 MB 整文件读数（已取）

```
PROBE big via=gh-proxy.com bytes=298662033 sha=8ebc7db18fffac7e71a2cf8487708053620d124846bc9502eddac1283b431d2b match=true seconds=93.4
```

- 资产就是随包清单里那一条（`resources/model-weights/manifest.json`：`bytes=298662033`、`sha256=8ebc7db1…`）；
- 原端点（Node 的 `fetch`/undici，不读系统代理）**自己失败** ⇒ 产品路径**自动**回退到 `gh-proxy.com`；
- 落地 **298,662,033 字节**、sha256 与清单**逐字符相同**，全程 **93.4 s**（≈3.2 MB/s；同一资产直连测得 138.7 KB/s
  ⇒ 若直连可用，同样一份要 ~35 分钟）；
- 第一次跑这条探针时我自己把 `createHash` 从 `node:fs` 引入（不是 `node:crypto`）⇒ 下载已完成、哈希那一步才炸。
  **如实记下**：那次 `seconds=63.3` 是「下载成功 + 哈希脚本报错」的时间，**不是**一次失败的下载；重跑才是上面这条读数。
  教训同 §一 末尾：**读数里出现「模块自己的函数不是函数」这类错误时，先怀疑探针，不要怀疑被测路径**。

## 六 复跑配方

```bash
# 1) 候选同一性 + 吞吐（每轮先删输出文件）
curl -sSL --noproxy '*' --max-time 40 -o /tmp/a.bin -w '%{http_code} %{size_download} %{time_total}\n' <ORIGIN>
shasum -a 256 /tmp/a.bin
rm -f /tmp/b.bin && curl -sS --noproxy '*' --max-time 30 -o /tmp/b.bin -w '…' "https://gh-proxy.com/<ORIGIN>"
shasum -a 256 /tmp/b.bin
# 2) 回退那一跳：临时探针调 streamUrlToFile(真 URL, dest, { expectedSha256 })，读 via 与落地 sha256
```

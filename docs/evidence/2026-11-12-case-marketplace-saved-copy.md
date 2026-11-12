# 案例市场的货架：一次 20 秒预算落在一个 739 字节的文档上

日期：2026-11-12（执行器本轮）
范围：`src/main/cases/marketplace-cache.ts`（新增）、`src/main/ipc.ts`（组合根一行）、
`src/main/cases/case-bundle-owner.ts`、`src/shared/case-bundle.ts`、
`src/renderer/src/stores/case-market-store.ts`、`src/renderer/src/pages/home/CaseMarketplace.tsx`
与九语词典各一条键。

## 一 读数来源与口径

打包版与 DEV 版各自的 `main.log` / `main.1.log` / `main.2.log`（只读，未改动），按
`scope=ipc`、`msg=ipc handler was slow`、`data.channel=cases:marketplace` 过滤，共 **80 行**。

## 二 时长分桶

| 桶 | 行数 |
| --- | --- |
| ≥19,000 ms（贴着读自己的 20 s 预算） | 17 |
| 10,000–19,000 ms | 17 |
| 2,000–9,999 ms | 18 |
| 500–1,999 ms | 27 |
| <500 ms | 1 |
| **合计** | **80** |

中位数 4,163 ms。贴死预算的那 17 行落在 **20,003–22,062 ms**：下沿贴着 20,000，上沿是定时器回调被
延后几秒（同一窗口里主进程有别的事在跑）——这正是「预算到点才结束」的形状，不是「算完了才结束」。

## 三 「是等还是算」的判决

`cpuMs` 来自 `process.cpuUsage()`，是**整个进程所有线程**的累计（`src/main/diagnostics/cpu-attribution.ts`
头注就写着 all threads）。三条判据合起来说明这 80 行不是「主线程在算」：

1. **5 行 `cpuMs` > `durationMs`**（20,005/26,928、7,100/11,488、3,231/5,258、1,430/2,402、1,024/1,149）。
   一个串行算完这次调用的线程不可能在 20.005 s 的墙钟里烧掉 26.9 s 的 CPU——多出来的部分在别的线程上。
2. 贴死预算那一组的 `cpuMs` 从 **503 到 26,928** 都有：同一形状（20,0xx ms）的等待里，CPU 可以几乎为零，
   也可以超过一整核 ⇒ `cpuMs` 不能用来判这条通道「在做计算」。
3. 结束时刻落在 20,003–20,041 ms ⇒ 预算定时器按点触发，主线程在那一刻**可被调度**。若主线程被自己的
   计算占满，定时器回调只会更晚，不会只晚 5 ms。

结论：这 80 行是**在主进程之外等**（对方主机/连接），不是本进程的计算。上一轮「9 行 cpu-bound、
cpuMs 12.8–26.9 s」把 all-thread CPU 读成了「这条通道在算」；本节的第 1、2 条否掉这个读法。

## 四 载荷规模：预算不是给体量的

用产品自己的 `fetchCaseMarketplaceIndex(CASE_MARKETPLACE_INDEX_URL)` 在本机实测（真实 GitHub 发布资产）：

- 索引正文 **739 字节**、1 条案例；
- 一次实时读 **3,984 ms**（同一时刻 `curl` 直取 0.79 s，差别在连接与重定向，不在体量）。

`CASE_MARKETPLACE_TIMEOUT_MS = 20_000` 罩的是**连接与主机**，不是文档：739 字节的文档值不上一个 20 秒
的转圈，而读不到时它一个字节也给不出。

## 五 交付：一次读成功就留在本机

新增 `src/main/cases/marketplace-cache.ts`：

| 事实 | 处理 |
| --- | --- |
| 成功读到的索引 | 落到 `<数据根>/cases/marketplace-index.json`（临时件 + 一次 rename，读者看不到半份文档） |
| 下一次读 | 有保存副本就直接答，**不问网络**（`source: 'cache'`） |
| 读者按「刷新」 | 请求里带 `refresh: true` ⇒ 走网络；成功则更新副本 |
| 刷新失败但本机有副本 | 答副本，并带上它自己的 `fetchedAt`（不是这次尝试的时刻） |
| 没有副本且网络失败 | 原样把拒绝交上去（`unreachable` / `bad-response` / `too-large` / `bad-index` 的原文不变） |
| 窗口自己给 `indexUrl` | 只走向那个地址，**不读也不写**本机副本（一个窗口点名的地址不该变成这台机器的货架） |
| 保存的文档 | 读回时用同一把校验器重新验；验不过就删掉、按「没有副本」处理 |

`CaseMarketplaceOutcome` 的成功分支现在**必填** `source: 'network' | 'cache'` 与 `fetchedAt`：界面要么说
「这是本机保存的副本（某时某刻取得）」，要么说这是刚读的——不存在靠省略字段冒充新鲜答案的写法。
货架页因此多一行 `data-slot="case-market-cached"`，只在 `source === 'cache'` 时出现。

## 六 本机真机读数（真实主机、真实文件系统，非替身）

`VITEST_LOCAL=1 npx vitest run src/main/cases/real-marketplace-cache.local.test.ts --disable-console-intercept`：

```
[shelf] live read: ok=true ms=3984 cases=1
[shelf] saved copy: fetchedAt=1794443035293 cases=1
```

同一支探针里第二次读注入的取回函数**只会抛错**（`the saved copy must answer without the network`），
而它返回了 `ok:true, source:'cache'`、条数与 `fetchedAt` 都与第一次相同 ⇒ 保存副本确实在**零网络调用**下作答。

## 七 边界（不许读成更强）

- **不是装机读数**：上面是本机一次（3,984 ms，网络此刻可达）。装机判据是下面两条，取自新版之后的日志：
  1. `cases:marketplace` 里落在 **20,000–22,100 ms** 的行数从 17 变 0（有副本就直接答，没副本才会走到预算）；
  2. 首次读成功之后的下一次启动，货架上应出现保存副本那一行；把它删掉再启动应回到「连不上索引」的拒绝，
     而不是空白货架。
- **没有改判定语义**：预算仍是 20,000 ms，`CASE_ARCHIVE_*` 的两条预算一个字节没动，下载/安装路径未触及。
- **没有动「什么时候该问网络」之外的策略**：货架不会自己定期刷新；刷新仍由读者那一按触发。
- **一条未取的读数**：这 80 行里有多少发生在「本机已有副本」的状态下，本版之前无从判断——日志里没有
  那个字段，下一版才第一次有。

## 八 复跑配方

```bash
# 日志聚合（只读）
python3 - <<'PY'
import json, os, statistical
# 见本节 §一 的过滤条件；输出分桶与贴死预算的行
PY

# 真实主机 + 真实文件系统
VITEST_LOCAL=1 npx vitest run src/main/cases/real-marketplace-cache.local.test.ts --disable-console-intercept

# 定向
npx vitest run src/main/cases src/renderer/src/i18n src/renderer/src/pages/home/CaseMarketplace.render.test.tsx
```

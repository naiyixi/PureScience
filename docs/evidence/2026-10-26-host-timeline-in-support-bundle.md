# 支持包自带「导出前那几分钟的机器时间线」

**为什么加这一段**：`diagnostics/event-loop-stalls.json` 只回答「某次卡顿那一刻机器什么样」。
用户真正会附上支持包的那些问题——「卡了一小时」「点保存就顿一下」——大多**没有一次跨过阈值的卡顿**，
于是整包对它们一个字都没有。同一个采样线程本来就在跑（`host-stall-sampler`，250 ms 一拍、常开），
它的环里躺着的正是这段时间线，此前只有卡顿窗口能读到它。

## 真窗口读数（本机实跑，非单测）

`npm run build:e2e` 之后跑 `playwright test e2e/support-bundle.spec.ts`——真窗口里点
Settings → General → Export support bundle，解包读 `diagnostics/host-timeline.json`：

```
[e2e] host-timeline status=timeline samples=21 capacity=1200 dropped=0 spanMs=4773 intervalMs=250 paging=readings:5
  2 passed (14.5s)
```

逐项对上：应用起来约 4.8 s，250 ms 一拍 ⇒ 21 条（含首拍），容量 1200（= 5 分钟 × 4 拍），
一条都没丢；macOS 上 `vm_stat` 解析出 5 条计数读数（每秒最多一条）。

## 形状（三态，缺席一律具名）

| `status` | 含义 | 会带什么 |
|---|---|---|
| `timeline` | 环里有样本 | `sampleCount`、`oldestAt`/`newestAt`、`spanMs`、`sampleCapacity`、`samplesDropped`（worker 自报）、`samples[]`、`paging` |
| `no-samples` | 采样器在跑但环是空的 | 只有容量与丢弃数；**不写 `samples: []`** |
| `unavailable` | 采样器从未启动（`sampler-not-started`）或线程没应答（`no-answer`） | `reason` 具名 |

`paging` 同理两态：`readings`（只带 `pageouts`/`swapouts` 两个数，不带平台原始文本）或
`unavailable` + `platform-exposes-no-counters` / `no-counters-parsed`。**没有读数不等于零**。

## 边界（不许读成更强）

1. 环是**有界**的（1200 条 ≈ 5 分钟）：超过就从头丢，丢了多少由 worker 自报（`samplesDropped`），
   所以「看到的只有 5 分钟」与「采样器刚起来」在读数上是两件事。
2. 这条时间线是**同一进程**内的线程采的，`peekSharedHostTimeline()` **故意不新建采样器**：
   导出发生在看门狗启动之前时，答案是 `sampler-not-started`，不是一条空表。
3. 时间线不解释因果：它只有「那一刻 CPU/内存/负载/页换出了多少」，把某一步慢归因到它需要另一层的读数。

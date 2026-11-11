# 保存的「写盘」不是字节问题：3.1 MB 文档实测 1.9 ms，而日志里的 `writeDiskMs` 中位 41 ms

> 单元范围：`sessions:save-session` 的 `writeDiskMs`（上一轮分段表里 29%，p90 360 ms、max 25.1 s）。
> 结论先行：**这一段不能用「少写字节」来治** —— 本机把真实语料里最大的那份文档整份写下去（含 `fsync`）
> 只用 **1.88 ms**，与日志里的读数差 20–200 倍。它记的是**等待**（共享线程池排队、或主线程不在了），
> 不是磁盘吞吐。因此本单元改为把「谁在排队」变成可判定的读数。

## 一 读数（本机现取；语料只读，写只落 /tmp）

真实语料 `~/.purescience-project/sessions/**/*.json`：**132 份 / 69.63 MB**（含两份索引相邻文件；
§三百一十二 记的是会话文档 66 份 / 68.99 MB，这 132 份是同一棵树的全部 `.json`）。

| 量                               | p50         | p90         | max                                                                        |
| -------------------------------- | ----------- | ----------- | -------------------------------------------------------------------------- |
| 文档大小                         | 0.022 MB    | 1.525 MB    | 3.118 MB                                                                   |
| 整份写出（含 `flush` + `fsync`） | **0.14 ms** | **1.02 ms** | **1.88 ms**（就是那份 3.12 MB 的；复跑一次 2.13 ms —— 两次都在 2 ms 量级） |

对照（打包版日志、789 条慢保存，见 §三百一十一 §三 的分段表）：`writeDiskMs` **p50 41 ms / p90 360 ms /
max 25,051 ms**。

复跑配方（只读真实语料，写只落临时目录，结束自删）：

```bash
python3 - <<'PY'
import os, time, glob, tempfile, atexit, shutil
docs = glob.glob(os.path.expanduser('~/.purescience-project/sessions/*/*.json'))
tmp = tempfile.mkdtemp(prefix='ps-wdisk-', dir='/tmp')
atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True))

def write_once(data):
    target = os.path.join(tmp, 'probe.json')
    t0 = time.perf_counter()
    with open(target, 'wb') as fh:
        fh.write(data); fh.flush(); os.fsync(fh.fileno())
    ms = (time.perf_counter() - t0) * 1000
    os.unlink(target)
    return ms

rows = [(len(data), min(write_once(data) for _ in range(3)))
        for data in (open(path, 'rb').read() for path in docs)]
print(len(rows), round(sum(r[0] for r in rows) / 1e6, 2), round(max(r[1] for r in rows), 2))
PY
```

## 二 由此被否掉的两条路

1. **压缩文档 / 去掉缩进 / 合并小写**：字节数与耗时在这台机器上不是同一个数量级的问题（3.1 MB → 1.9 ms）。
   照字节去优化，最好的情况也只是把 41 ms 里的几毫秒挪走，而 p90 三百多毫秒动不了。
2. **「加缓存、别重复写」**：渲染层的 `LATEST_SAVE_COALESCE_MS = 350` 已经在做 latest-wins 合并，
   主进程侧的 `queuedMs` 只占 3%（p90 2 ms）—— 没有证据表明存在重复写。

## 三 真缺口：判定器看不见保存

现有的停滞判定（`src/main/diagnostics/stall-cause.ts`）里，`fs-queue-saturated` 需要
`fs.inFlight > 0`，而 `inFlight` 只统计**自报**的操作（`beginFsOperation`）。在此之前，全树只有
**预览资源获取**一条路自报 —— 于是保存（应用里最大的 fs 扇出：权威读 + 建目录 + 写文档 + 写索引）
在判定器眼里永远回答「我们没有东西在排队」。这不是「池子很闲」，是**看不见**。

同一份文件里记着这条 gate 的来历：3,460 条标成 `fs-queue-saturated` 的历史记录里 **3,436 条 `inFlight: 0`**，
canary 中位数比停滞本身还长 4.1 倍（p90 9.9 倍）—— 那条标签当时描述的是「已经不在了的循环」。
所以正确做法不是放宽 gate，而是**让该自报的路径自报**。

## 四 交付

| 位置                                          | 改动                                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/session-persistence/repository.ts`  | 新增 `reportFsOperation`（`begin` / `try` / `finally end`），包住保存路径的四步：权威索引读、权威文档读、建目录、`atomicWrite`（临时文件写 + rename）、索引写。失败路径同样在 `finally` 里落回 0 |
| `src/main/session-persistence/coordinator.ts` | 慢行新增 `peerFsOperations`：写返回那一刻**我们仍在排队**的操作数（与判定器同一口径：不是池深、也不含本次自己的写）                                                                              |
| `src/main/diagnostics/stall-cause.ts`         | 把「今天只有预览获取自报」那句改成现状（两条路），避免下一位读者按旧注释判盲区                                                                                                                   |
| `repository.test.ts`                          | +2 例：四步各自自报且值恰为 1、结束后归零；失败步骤也归零                                                                                                                                        |
| `coordinator.test.ts`                         | 既有的写分段用例 +1 条断言：`peerFsOperations` 随写一起进慢行                                                                                                                                    |

**两条设计判据**：
① **计数器不是时钟**：它只说「我们有操作在飞」，不说多久 —— 这正是把「池子忙」与「循环不在了」分开所需的那个量（`fs-queue-saturated` 的 gate 就是靠它）。
② **作用域是保存路径，不是全树扫描**：启动期 51 次 `listFiles` 是另一域、另一个读数；把它也塞进来会让同一个数字承载两种含义。

## 五 门禁（全部实跑）

| 环                                                                | 读数                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/session-persistence` + `src/main/diagnostics`           | **39 files / 481 passed**，exit 0                                                                                                                                         |
| 双 typecheck（`--composite false`，node 侧 `NODE_OPTIONS=…8192`） | node 0；web 0                                                                                                                                                             |
| `eslint --no-cache`（5 文件）                                     | 0 error / 0 warning                                                                                                                                                       |
| 变异自证                                                          | ① 去掉 `reportFsOperation` 的 `begin`/`end` ⇒ 新用例当场红（1 failed / 59 passed）；② 去掉慢行的 `peerFsOperations` ⇒ 协调者用例红（1 failed / 121 passed）。两次都已还原 |

## 六 边界（不许读成更强）

- **这不是优化**：没有一处用户可见行为改变，**不能声称变快**。
- **没有装机读数**：本改动在 main 上，打包版要等下一次发版才带电。装机后的判据有两条，缺一不可：
  ① 慢保存行里 `peerFsOperations > 0` 的比例（现在恒缺省/0 ⇒ 说明只有保存自己那一步，没有别的在排队）；
  ② 同一时间段里 `event loop stalled` 记录的 `cause.kind = 'fs-queue-saturated'` 开始出现，且 `basis` 里写着
  「N of our reads waiting」。只有①没有②，说明 canary 没到门限（池子不忙），那是另一回事。
- **全树扫描仍不自报**（启动期扇出、按需目录列举）：它们不是保存的一部分，需要时按调用点各自自报，
  不在这里顺手加。
- `reportFsOperation` 包住的是**整个步骤**（含文档解析），所以 counter 在解析期间也算「在飞」——
  与预览路径 `resolve + stat` 的同一种口径；它不会被读成「解析在等池子」以外的意思。

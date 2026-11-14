# 可用空间是「卷」的读数，不是「路径」的读数（2026-11-14）

## 一句话

存储面板在**数据根还不存在**时报「读不到可用空间」，而那件事本来是可以量到的：free space
属于路径所在的卷，`statfs` 问的也是卷。改成「问最近的、真实存在的祖先目录」，读数就有；只有当
**卷本身读不出来**（未挂载、无响应）时才保持「没有读数」，并且仍然具名落日志。

## 真机语料（不是推演）

`~/Library/Logs/PureScience (DEV)/main.log`，用仓库自带 `scripts/log-corpus-attribution.mjs` 切开归属后，
warn 家族里的 `available storage lookup failed`：

```
44  available storage lookup failed  (real 0 | fixture 8 | mixed 0 | unattributed 36)
```

逐行看 `data`，**44 行全部是 `errorCategory: 'not-found'`**（即 `statfs` 的 `ENOENT`），没有一行是
权限/IO/超时。**归属要先说清**：`real 0 / fixture 8 / 无会话身份 36` —— 设置面板这一类调用本身不携带会话身份
（它不属于任何一个会话），所以「0 real」不等于「没发生过」，这 36 行就是本机 DEV 实例自己的面板读数。
时间跨度与该目录被创建的时刻对得上：`~/PureScience-DEV` 的 mtime 是 **11-10 00:14**，
而这 44 行全部在它存在之前产生的实例里。⇒ 成因不是「卷坏了」，而是**默认数据根当时还没被写出来**。

同一形态在打包版上不存在（`PureScience/main.log` 里该族 0 行）——因为那个根早就存在了。

## 改动

| 位置 | 改动 |
| --- | --- |
| `src/main/storage/usage.ts` | `availableBytes(targetPath, { statfsOf? })`：从目标路径起逐级向上找到**第一个能读到 `statfs` 的祖先**，返回该卷的 `bavail * bsize`；只有「不是 ENOENT/ENOTDIR 的错误」才立刻抛（权限/IO 已经说明了卷的真实情况，不该拿父目录的答案顶替）；一路问到文件系统根仍读不到才抛最后一个错误（有界，不会空转） |
| `src/main/storage/command-owner.ts` | 该读数改为可注入（`deps.availableBytesProbe`），生产默认不变；`available: null` 这一支的注释就地更正为「卷读不出来」，因为「根不存在」已经不再落进这一支 |
| `src/test` | 五条 `availableBytes` 用例（存在路径 / 单层缺失 / 多层缺失 / 卷不可读时抛错而不是回 0 / 问到根就停）+ IPC 层两条（卷不可读 ⇒ `null` 且落一条 `available storage lookup failed`；**根尚不存在 ⇒ 读到真数字、且不落失败行**） |

判据的方向：这不是把「量不到」放宽成「随便给个数」。原来那一支的**意图**（没人量过的数字不许以 0 出现）
被完整保留，只是那个终态现在只在**真的量不到**时才会到达；原来被它吃掉的「路径还没建」现在有了真读数。

## 门禁（本机实跑）

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/main/storage/usage.test.ts src/main/storage/ipc.test.ts --maxWorkers=2` | **2 files / 87 passed**，exit 0 |
| `npx tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 |
| `npx tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `npx eslint --no-cache`（本笔四文件） | 0 problems |

## 边界（不许读成更强）

1. **没有窗口读数**：这是主进程的读数通道，界面文案未改（原本就会在 `null` 时说「读不到」）；本笔不声称
   面板外观有任何变化，只声称「该面板在这种情况下拿得到数字了」，证据到 `storage:get-info` 的返回值这一层。
2. `statfs` 的答案是**瞬时**的，两次调用之间字节会变；用例只断言「与同一个祖先的读数相等」，不比绝对值。
3. 该改动不消除 `dataRootMissing` / 迁移提示那条独立逻辑（它判的是「显式配置过、现在没了」，本笔未动）。
4. **具名未办**：`src/main/compute/harvest-engine.ts:297` 的下载前余量闸仍然**无 try/catch**——卷读不出来时
   会从那里抛出，把一次已完成远端作业的 finalize 整段丢掉（`harvestedAt` / `harvestError` / 通知都不写）。
   本笔让「目录不存在」这一类不再触发它，但「卷不可读」这一类仍在。修法需要给该引擎加一个可注入的读数
   （现在 `availableBytes` 是直接 import），属独立单元，本轮不动。

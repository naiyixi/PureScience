# 中文标题的产物名把整次写入拖下水：侧车名按字节算，不再按字符编码膨胀

> 日期：2026-10-21 · 执行器 · 证据类型：真机日志（用户自己的运行）＋ 真实文件系统复现（非窗口读数）

## 一 现象与出处（读数，不是推测）

用户自己的应用日志 `logs/headless.out.log` 第 **9474** 行（会话 `48fb3b1c-1dbc-4908-a6b6-20581f24e11d`）：

```
[acp] tool call failed {
  tool: 'purescience-artifacts/write_artifact_file',
  toolCallId: 'call_00_G6DaTyrRSxI9kdvk8Ql12681',
  sessionId: '48fb3b1c-1dbc-4908-a6b6-20581f24e11d',
  reason: "ENAMETOOLONG: name too long, open '…/.pending/artifact-run-1789745855114-1/.metadata/%E5%9B%BA%E6%9C%89%E6%97%A0%E5%BA%8F%E6%8A%97%E5%8E%9F%E6%9E%84%E8%B1%A1%E7%86%B5%E5%86%BB%E7%BB%93%E7%BD%9A%E9%A1…'"
}
```

- 这是一次**整笔产物写入失败**：文件没落地，读者只看到一句 `ENAMETOOLONG`，而那句话点的是**临时侧车路径**，
  不是他自己写的标题——所以既不知道是标题的问题，也不知道该改什么。
- 同一个日志里 `ENAMETOOLONG` **只出现 1 次**（`grep -c` 口径：1 行），即这不是海啸，但它是一条**沉默的必失败路径**：
  凡是超过那个长度的中文标题，每次都会失败，且失败得很像基础设施问题。

## 二 为什么会撞上：一份按字符编码膨胀的名字

`getArtifactMetadataPath()` 把**整个**产物名百分号编码成一个文件名：

```ts
join(directory, METADATA_DIR, `${encodeURIComponent(filename)}.json`)   // 改前
```

一个 CJK 字符是 3 字节 UTF-8，`encodeURIComponent` 把它变成 9 个 ASCII 字符（`%E5%9B%BA`）。
于是**文件名本身合法**的中文标题，其侧车名会膨胀到三倍：

| 名字 | 字节（UTF-8） | 侧车名长度 | 结果 |
|---|---|---|---|
| `plot.png` | 8 | 13 | 正常（改前改后都正常） |
| 30 字中文标题 | 84 | **270** | 超过单段 255 字节上限 ⇒ `ENAMETOOLONG` |

⇒ 改之前，**约 27 个中文字**（83 字节）就是死线；而 27 个字在科研场景里连半个标题都不到。

## 三 今天在真实文件系统上复现（RED，改前）

新增用例的第一跑（`npx vitest run src/main/artifacts/storage-access.test.ts`，exit 1）：

```
× bounds the sidecar for a long CJK title instead of tripling every byte
  AssertionError: expected 270 to be less than or equal to 255
× round-trips metadata for a long CJK title through a real directory
  Error: ENAMETOOLONG: name too long, open '/var/folders/…/.metadata/%E5%9B%BA…%E7%A8%BF.csv.json.<uuid>.tmp'
× uses a bounded name when the encoded one would fit only without the write suffix
  Error: ENAMETOOLONG: name too long, open '/var/folders/…/.metadata/aaaa…aaa.csv.json.<uuid>.tmp'
```

第二、第三条同时暴露了**第二处**同类隐患：写入用的是 `.<uuid>.tmp` 临时名（41 字节），
所以「刚好 255 字节」的侧车名**在写临时文件时**就炸——判定阈值必须先把这段后缀留出来。

## 四 修法（三处，默认路径逐字节不变）

| 位置 | 改动 |
|---|---|
| `src/main/artifacts/storage-access.ts` | 侧车名分两套：编码后**能放下**（≤ 214 字节 = 255 − 41 的临时名后缀）就仍用**原来那个名字**，一个字节不变；放不下改用 `@long-<sha256 前 32 位>.json`（有界、按内容定址）。`@` 不可能出现在编码名开头（`encodeURIComponent('@')` 是 `%40`），两套永不撞名 |
| 同上 | `readArtifactMetadata()` 按同一顺序读**两个候选名**（先首选、缺了再看另一套），磁盘上老侧车照旧解析；不是「缺文件」的错（损坏、权限）仍然抛 |
| 同上 | `assertSafeFilename()` 增加**字节上限 191**（= 255 − 64 的事务后缀预留），超限抛具名错误：报字节数、报上限、并带上（截断的）名字 —— 替掉一次只报临时路径的 `ENAMETOOLONG` |
| `src/main/artifacts/mcp-server.ts` | `write_artifact_file` 的 `filename` 描述补一句「191 字节以内（中文约 60 字）」——让模型在**提交前**就收住，而不是失败后重试 |

**为什么阈值是 191 / 214 而不是 255**：一次产物写入会在真实文件旁边写下 `.<epochMs>-<uuid>.backup`（57 字节），
一次元数据写入会写 `.<uuid>.tmp`（41 字节）。把接受上限卡在 255，只会把失败推迟到事务中间，
报的还是同一句 `ENAMETOOLONG`——那正是这条缺陷的形状。

## 五 读数（全部实跑，取自最后一次改动之后）

| 环 | 读数 |
|---|---|
| 定向 `src/main/artifacts/storage-access.test.ts` | 改前 **4 failed / 6 passed**（RED，含场内 `ENAMETOOLONG`）→ 改后 **11 passed** |
| `src/main/artifacts` 全套 | **20 文件 / 282 passed**，exit 0 |
| `mcp-server.test.ts` | **26 passed** |
| 真实文件系统事务（不是纯单测替身） | `runPendingFileTransaction` + 30 字中文标题 + 真实目录：产物落地、`.metadata` 侧车 1 个且 ≤255 字节、无 `.tmp`/`.backup` 残留 |
| 兼容 | 手写一份改前 scheme 的侧车（`résumé — 终稿.csv.json`），改后仍能读回 |

「真实文件系统事务」这一条用**产品自己的函数**（`runPendingFileTransaction` ＋ `ArtifactStorageAccess`）跑，
不是替身；但它**不是窗口读数**：没有起 Electron。

## 六 边界（不许读成更强）

1. **没有真窗口读数**。判据缺口：需要一次打包态/无头实例里的 `write_artifact_file` 真调用。本轮未取，
   原因具名：内存闸门（见 §七）。单元与真实文件系统读数都不等于实机。
2. **不改产物显示名**：用户写的中文标题就是最终文件名（≤191 字节时），本次只改**侧车**与**上限检查**。
3. **不改既有侧车**：磁盘上按老 scheme 写的侧车不迁移、不重写，只是继续能读。
4. **超限的名字仍然会被拒**（这是有意的）：区别是从一句指向临时路径的 `ENAMETOOLONG`，变成一句说清
   「多少字节 / 上限多少 / 哪个名字」的拒绝。

## 七 具名未办

- 真窗口读数：`blocked-by` = 内存闸门（本轮取数：空闲页 3,860 ≈ **60 MB**、`swap used 13.6 G / 15.0 G`）。
  解封判据：起一次隔离根的实例，用真 `write_artifact_file` 写一个 30 字中文标题的 CSV，读到
  `artifact.name` 与磁盘文件都在、`.metadata` 里只有一个有界侧车。
- 打包态下 `.metadata` 侧车名是否被任何导出/审计面按名字反解（本轮 grep：`METADATA_DIR` 的消费方只有
  「目录空不空」一处判断，没有反解）——若下一版新增按名字反查的读者，必须走 `getArtifactMetadataPath`，不得自己拼。

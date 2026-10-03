# S3 增量全文索引：S4 四条真机断言读数

> 日期：2026-10-03。依据 `docs/plan-2026-10-03-S3-incremental-fulltext-index.md` §4 的 **S4**，
> 以及 `docs/plan-2026-10-03-v1.81.0-queue.md` 的 **V3**（本版发版门）。
> spec：`e2e/certification/search-index-coverage.spec.ts`（新建；此前仓里没有 S3 的认证 spec）。
> 读数：`npx playwright test e2e/certification/search-index-coverage.spec.ts --workers=1` → **1 passed (55.2s)**。

## 0. 语料怎么造的（先说清楚，否则读数没有意义）

索引的语料**只有项目文件**（`createSearchIndexService` 的唯一语料端口是 `listFiles(projectId)`，
`src/main/ipc.ts:1280-1314`；会话**不在**索引里——S3 立项档里提过的会话指纹这一片从未接线）。
所以 spec 走**用户自己的路径**注册文件：

1. 在隔离根可见的目录里写 3 个文件，关键词 **只放在正文**（`corpus-N.txt` 的正文行里），
   这样"命中"只可能来自读文件、不可能来自文件名；
2. 每个文件调一次应用自己的 `uploads.stageLocalPath({ transferId, name, sourcePath, projectId })`
   —— 就是预览面上「把本地文件存为产物」走的同一条通道（不是直接写索引存储）；
3. 读回 `projectFiles.listFiles` 确认文件真的进了项目文件索引（**前置断言**），
   否则整条 spec 可能在空语料上"通过"。

读数：`corpus registered: {"staged":3,"files":3}` —— 3 个文件都进去了。

## 1. 四条断言的真机读数（逐字）

| 判据 | 读数 | 判定 |
| --- | --- | --- |
| ① 新导入后立即搜索出现**未覆盖提示与数量** | 首次搜索：面板 `index summary: (no index summary on screen)`、`absent notice: (absent notice not shown)`；命中 **1**（现场扫描找到，不依赖索引） | ⚠️ **部分成立，见 §2** |
| ② 索引完成后同一查询**由索引见证为最新** | 点「立即索引」后：面板 `Indexed 3 · 0 pending`；契约块 `{"present":true,"indexed":3,"pending":0,"capped":false,"measuredAt":"2026-10-03T11:30:32.963Z"}` | ✅ |
| ③ **中断续跑不回退** | 重启进程后同一查询：`{"present":true,"indexed":3,"pending":0,...,"measuredAt":"…11:30:39.528Z"}` ⇒ `indexed` **不回退**（磁盘 checkpoint 权威） | ✅ |
| ④ 删掉索引目录 ⇒ 覆盖读数为「空」而**不是**「没有结果」 | 删 `<dataRoot>/search-index/` 后：覆盖块 `{"present":true,"indexed":0,"pending":3,…}`（**空覆盖**）；同一次查询 `{"hits":3,"counts":{"uploads":3,"sessions":0,"messages":0,"artifacts":0,"literature":0,"annotations":0}}`（**结果非空**） | ✅ |

判据④是这一片最要紧的一条：`indexed:0` 与 `hits:3` **同时**成立，才说明"索引没了"没有被讲成"什么都没有"。

## 2. 判据①的诚实修正（不是全过，**不改口径而是改措辞**）

立项档把①写成「新导入一批文档后立即搜索 ⇒ 出现未覆盖提示与数量」。实测**首次**搜索时面板**什么都不说**：
响应里**不带** `index` 块（契约里"没接索引"与"空索引"本来是两句），所以面板没有可渲染的读数。

- 覆盖读数（含**未覆盖的数量**）在**有过一次测量之后**才出现：删目录那次读到的 `pending:3`
  正是"3 条未覆盖"——**数字是真的、也会显示**，只是第一次搜索来不及有。
- 因此①的准确表述应为：**「首次搜索不谎报覆盖（宁可不说）；一旦有测量，未覆盖量以 `pending` 给出」**。
- **顺带立一条可选项**：面板在"索引已接但尚未测量"时可以显示一句「尚未测量」（而不是整块不出现）。
  这属于界面文案层，未在本片做，记在此处免得下次又被当成"已覆盖"。

## 3. 过程中修掉的两处**我自己的**错误（写下来避免重犯）

1. **请求字段名**：`search.query` 的入参是 `{ query, projectId?, refreshIndex? }`，不是 `{ text }`。
   第一版传错名字 ⇒ 主进程对 `undefined` 调 `.trim()` 抛错。**读类型再写调用**。
2. **"最后一次测量"语义**：覆盖块是**上一次 tick 的测量值**，`measuredAt` 才说明它有多新。
   删目录后第一条查询仍可能带回删之前那次测量 ⇒ 断言必须**轮询到重测落地**，不能拿第一口读数下结论。
   这不是测试技巧，是这条契约的性质。
3. 顺带：结果行的可定位锚是 `[role="listbox"] [role="option"]`（面板自用 `data-testid="gs-*"` 只覆盖它自己的控件）。

## 4. 收尾复核

- 数据根是夹具的隔离根：`/var/folders/…/T/purescience-electron-e2e-<id>/storage/PureScience-DEV`，
  真实根 `~/.purescience-project` 未被写。
- 本 spec 自己在隔离根里删了 `search-index/`（**这就是判据④要做的动作**），且只在该夹具目录内。
- 未改动任何生产代码：本片只是把已落地的 S3 能力**取到读数**。

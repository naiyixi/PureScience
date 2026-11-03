# 案例排序查证：`ManagedFile` 这 1143 行，指向的东西磁盘上没有

> 2026-11-05，本机（`~/.purescience`）。排期里"排序改主进程聚合"写着
> "`内部评测` 有 126 个 ManagedFile，目录只报 0，因此没浮上来"。
> 本文只记录**实测到的事实**与**尚未settle 的歧义**，不据此改排序。

## 1. 数据库这一侧的计数

```sql
-- 未删除的 ManagedFile 共 1143 行
SELECT COUNT(*) FROM ManagedFile WHERE deletedAt IS NULL;   -- 1143

-- 按项目
SELECT p.name, COUNT(*) FROM ManagedFile m JOIN Project p ON p.id = m.projectId
 WHERE m.deletedAt IS NULL GROUP BY p.id ORDER BY 2 DESC LIMIT 3;
-- 内部评测 126 / 内部测试题 124 / 分子对接2753个 96  （这 126 行全部 source='artifact'）
```

`内部评测` 那 126 行的 `storageKey` 形如：

```
artifacts/cmvceawow0000wf81cnzqbjx2/21df9206-…/.provenance/12fa7d64-…/versions/b69ac018-…/content
```

即：**一行 = 某个 artifact 的某个版本的 content**。所以 `artifactCount`（首页排序用的就是这个）量的是
**版本产出次数**，不是"交出了几个文件"。同一 artifact 改一次就多一行。

按去重口径对同一个项目再算一次：126 行 / **122 个不同 `displayName`** / 126 个不同 artifact 目录，
而 `ManagedFileSessionSync` 里 `artifactCount > 0` 的组只有 **11** 个。
三个数都不一样，说明"文件数"在这套数据里没有唯一答案 —— 这正是不能随手换排序基数的原因。

## 2. 磁盘这一侧：找不到

`~/.purescience/artifact-store/` 的实际内容：

```
artifacts.db  artifacts.db-shm  artifacts.db-wal  blobs/  partial/
```

- **没有 `artifacts/` 目录**，而 1143 行的 `storageKey` 全部以 `artifacts/…` 开头。
- 逐个 `os.path.exists` 检查：抽 300 行 → **300/300 不存在**；`内部评测` 126 行 → **126/126 不存在**。
- 内容寻址库 `artifact-store/artifacts.db`：`blobs`、`artifacts`、`versions`、`executions` **四张表都是 0 行**。
- 其余候选根（9 个 `electron-userdata*` 目录）**都没有 artifact-store**。
- 该根目录身份的依据：`~/.purescience/external-mcp.json` 里 `configRoot = /Users/totota/.purescience`，
  代码里 `PROD_SESSION_DIR_NAME = '.purescience'`。

## 3. 尚未 settle 的歧义（不改代码的理由）

两种可能，本轮无法从数据侧区分：

1. **字节确实不在了**（迁移到内容寻址库时没有回填，或清理任务删过）：那么首页案例卡片"读到 0 个文件"
   不是排序问题，而是**索引与磁盘脱节**——先修这个，排序再怎么改都是给错的基数排顺序。
2. **应用解析的根不是 `~/.purescience`**（例如按安装形态或用户设置换了数据根）：那么上面所有"不存在"
   的结论作废，得先拿到应用实际的 data root 再测。

判定方法（下一轮做）：用应用自己的 `resolveManagedFilePath` 对一个已知 `storageKey` 求值，把结果打到日志；
或跑一次 `project-files:list` 看它返回什么。**在看到应用自己给出的绝对路径之前，不发布任何"数据丢失"或
"排序基数该换成什么"的结论。**

## 4. 因此本轮做了什么、没做什么

- 做：把上述计数口径与磁盘核对写成文档（就是本文），让"126 vs 0"这句话从传闻变成可复算的数字。
- 没做：没改排序（`artifactCount` → `artifactGroupCount` 等都不改）；没改索引；没写"数据丢了"的结论。
- 排期项"排序改主进程聚合"保持未勾，理由从"没时间"变成"**前置歧义未解**"。

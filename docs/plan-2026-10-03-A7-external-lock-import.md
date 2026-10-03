# A7 外部锁导入 —— 立项与切片（2026-10-03）

> 队列 `docs/plan-2026-10-03-next-queue-and-round-convention.md` §B.1。本文件是该项的**立项**：
> 目标、现有资产、缺口、差异化点、切片顺序、真机验收与明确不做。实现按切片提交，每片可独立收口。

## 1. 目标

设置 → 运行时 增加**「从锁文件导入环境」**：用户粘贴或选择一份**外部** `@EXPLICIT` 锁
（conda 风格，每行 `https://…/pkg.tar.bz2#<md5>`），应用逐包 md5 校验、把 tar 包放进共享缓存，
再用既有 `createFromLockArgv` **离线**建一个具名环境；结果给出**覆盖率读数**
（总数 / 缓存命中 / 新下载 / 逐条缺件具名原因）。

**为什么是"超车项"**：对标的环境包**只支持版本绑定的完整包**，外部锁导入明确未做；我们已有
「从锁离线重建」的机制，只缺**入口 + 从锁 URL 取回 tar 包的通道**（研究结论见
`docs/plan-2026-09-30-v1.77.0-search-models-skills.md:344`）。

## 2. 现有资产（都在树上，非新建）

| 能力                                                | 位置                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------ |
| 离线从锁建 env / 应用基线锁                         | `src/main/notebook/micromamba.ts` `createFromLockArgv` / `installFromLockArgv` |
| 规范化解锁（`list --explicit --md5` 输出 → 合法锁） | 同上 `normalizeExplicitLock`                                                   |
| 锁解析 + **必须 32 位 md5 否则拒绝**                | `src/main/notebook/pack-content.ts` `lockPackages`                             |
| 从本地目录 seed 到共享缓存 + md5 复算               | 同上 `validateAndSeedPack`                                                     |
| 具名环境在线 create（崩溃日志/清残前缀/验解释器）   | `src/main/notebook/provisioner.ts` `createNamedEnvironment`                    |
| 可续传/重试/进度下载                                | `src/main/net/resilient-download.ts` `resilientDownload`                       |
| 环境管理入口（校验名/语言、活跃内核保护）           | `src/main/notebook/environment-management.ts`                                  |

## 3. 缺口

1. 锁里的 tar 包**不在共享缓存**时的取回路径（下载 + md5 校验 + 存入缓存）——本片新增。
2. 一条**渲染器可调用**的通道（`runtime:import-lock`）+ 契约目录条目 + `gen:web-api-map`。
3. 界面入口（粘贴/选文件 + 进度 + 覆盖率结果）。

## 4. 差异化点（必须优于对标，逐条可核验）

1. **缺校验就整份拒绝**：锁里任一行没有合法 32 位 md5 ⇒ 整份拒绝，不当"尽力而为"。
2. **逐包校验，缓存也复算**：命中的缓存文件也重算 md5；不符则删除并按缺件处理（绝不"文件在就当对"）。
3. **覆盖率诚实报告**：返回 `total / fromCache / downloaded / missing[]`，缺件逐条具名原因；
   **不静默少装**、不把失败改写成成功。
4. **离线优先、可完全断网**：`allowDownload:false` 时**一个字节都不联网**，缺件即具名失败；
   **不做**"锁建失败就悄悄转在线 solve"（与「确定性复现」的产品语义冲突）。
5. **确定性**：建成的环境等于锁指定的精确包集合（离线 `create --file lock` 语义），不是"解得差不多"。

## 5. 切片

- **S1（main 能力）✅ `cd2bd978`**：`provisioner.createNamedEnvironmentFromLock(name, language, lockText, opts)`
  —— 解析 → 逐包缓存校验/取回 → 日志化建前缀 → 验解释器 → 返回 `EnvironmentInfo + ImportLockCoverage`。
  单测覆盖：全命中 / 需下载 / 缺件(离线) / 坏 md5 / 缺校验行 / 非法名 / Windows 路径预算 / 进度。
- **S2（通道）✅**：shared 类型（`ImportLockRequest` / `ImportLockCoverage` / `ImportLockResult`）→
  `environment-management.importLock`（校验名/语言 + 恢复顺序 + 逐环境 mutation 锁，把失败映射为
  `{status:'incomplete'}` 判别联合）→ `runtime-service.importEnvironmentFromLock` → workflow `importLock`
  → `runtime:import-lock`（ipc，LOCAL）→ `renderer-contract-catalog.ts` → `npm run gen:web-api-map`
  → preload + `renderer-api.d.ts`。
- **S3（界面）✅**：RuntimesPanel 每种语言区块的 action 加「从锁文件导入…」按钮 → 对话框
  （环境名 / 锁内容 Textarea / 「允许下载缺件」开关 / 进度条 / 覆盖率结果与逐条缺件原因 /
  成功后刷新卡片）+ **9 语种** i18n（13 个键，zh ≠ en，跑 `translation-quality.test.ts` 通过）+ 渲染测试 4 例。
  - **进度通道**：复用既有 `notebook-env:progress` 广播，但 store 对 `phase==='import-lock'` 单独落到
    `importProgress` 字段（**不**触碰按语言的 provisioning 卡与启动横幅）。
  - 锁输入为**粘贴**（一个 Textarea）；「选文件」需要第二条通道（`*:pick-lock`），本片不做，见 §6。
- **S4（真机验收）**：隔离根（`PURESCIENCE_STORAGE_ROOT` + `settings.dataRoot` 指隔离目录）真窗口：
  ① 全命中锁 → 建成 env、**0 下载**、解释器可跑并 `import` 一个包；
  ② 缺件锁 + `allowDownload:false` → 具名失败、不建 env；
  ③ 坏 md5 锁 → 拒绝并具名。读数落 `docs/evidence/2026-10-03-A7-external-lock-import.md`。

## 6. 明确不做（本片）

- **不做**活体环境导出（那是 A7 的邻居项，另立案）。
- **不做**在线 solve 回退（锁建失败 → 不静默转 `createNamedEnvironment`）。
- **不做**「选文件」入口：需要第二条通道（`runtime:pick-lock` 之类），会再撬动一轮契约计数；
  本片的锁输入是**粘贴**。用户可从 `micromamba list --explicit --md5 > lock.txt` 取内容后粘贴。
- **不改** agent 工具 `manage_environments` 的请求形状（本片只加**渲染器通道**；agent 侧要加另立项）。
- **不做**镜像重写（锁里的 URL 按原样取；CN 镜像重写另立案，避免本片被网络问题拖死）。
- 不新增运行时依赖；不引入新包。

## 7. 隔离与清理（与队列纪律一致）

真实配置根只读；一切写入落 `/tmp` 隔离根；验收用的锁/缓存夹具从真实缓存**只读复制**；
收尾停进程、确认端口无监听、删临时目录、`git status` 干净。

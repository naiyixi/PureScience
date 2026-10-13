# P0-10③ 会话半边：删掉一个会话要真的释放它的 run 数据（2026-10-13，自主执行器）

## 一 缺口（核源取得，逐条 file:line）

- 真实布局：`<dataRoot>/notebooks/<projectId>/<sessionId>/{data,outputs,cache,handoff,work,scripts,run.json}`。
  本机实测：`~/.purescience/notebooks` 有 37 个目录，且这 37 个目录名与库里的 37 个 `Project.id` **逐个相等**
  （`comm -12` = 37）⇒ 项目那一层的寻址是对的，缺的是 `<sessionId>` 这一层。
- **项目半边早已交付**：`src/main/notebook/session-data-cleanup.ts` 的 `deleteProjectNotebookData()` →
  `src/main/ipc.ts` 组合根装配 → `deletion-coordinator` 并入 `runDataBytes` → `HomePage.tsx` 按
  `refused` / 未测量 / 释放字节三种口径出话。
- **会话半边此前不存在**：`src/main/acp/session-deletion-workflow.ts`（122 行）零 notebook 引用（只做
  provider / 内存态拆解）；`sessions:delete-session` 只删持久记录并清理权限授予，磁盘上
  `<projectId>/<sessionId>/run-*/…` 原封不动 —— 本机实测单个会话可占 1.1 GB，而界面对这些字节只字不提。

## 二 交付（按层）

| 层 | 落点 | 要点 |
| --- | --- | --- |
| 清理本体 | `src/main/notebook/session-data-cleanup.ts`（新函数 `deleteSessionNotebookData`） | 两个 id 段各自按名拒绝（`SAFE_ID_SEGMENT`，项目 id 的旧常量就地改名）；`removed` / `absent` / `refused` / `failed` 四态；删前测量；`rm` 失败**报 0 字节 + `failed`**，不谎报释放量 |
| 回执类型 | `src/shared/session-persistence.ts`（`SessionNotebookDataDeletion`、`DeleteSessionResult`） | 会话级比项目级多一个 `failed`：**会话记录此刻已经没了**，删不掉不能读成 `refused`（id 从没寻址到东西）或 `absent`（从来就没存过） |
| 组合根 | `src/main/ipc.ts` | `sessionNotebookDataDeletion` 照项目级先例（每次现取 `resolveDataRoot()` + `createLogger('notebook')`），接在**持久记录删除成功之后**（协调器有软删令牌回滚窗口，先删字节会在回滚时变成数据丢失），并把回执并进删除结果 |
| 通道 | `src/main/session-persistence/ipc.ts` | 后端 / 处理器 / 通道三处 `deleteSession` 返回类型改为 `DeleteSessionResult`；`sessions:delete-session` 现在**返回**回执而不是丢弃（工厂三参只读的口径守卫未被破坏——字节删除接在组合根，不注入工厂） |
| 应用命令面 | `src/main/data-content-application-commands.ts` | `sessions:delete-session` 把回执 `return` 出去（Web/命令面与窗口面同一条链） |
| 桥与渲染端 | `src/preload/renderer-api.d.ts`、`src/renderer/src/lib/session-persistence/session-persistence.ts`、`useWorkspaceAgentRuntime.ts` | 桥、接口、`deleteWorkspaceSession` / `deleteRuntimeSession` 全部改型为回执；`notebookData` 缺席＝持久删除根本没发起，**不许读成「没存东西」** |
| 界面（工作台） | `WorkspacePage.tsx` + `WorkspaceSidebar.tsx` | 删除完成后在侧栏会话列表上方出一句 `role="status"` + `data-slot="sidebar-session-deleted"` 的可关闭通知，写明释放了多少（或未释放）；**存的是回执而不是预先渲染好的句子** ⇒ 切语言会重渲染 |
| 界面（设置·已归档） | `ArchivedPanel.tsx` | 同一通道的第二个面，同一句话：`data-slot="archived-session-deleted"` |
| 一句话唯一来源 | `src/renderer/src/lib/session-deletion-notice.ts` | 两个面共用一个映射函数（三个键：`released` / `nothingStored` / `runDataKept`），避免两处三元式各自漂移 |
| 文案 | 9 语 × 3 键 | zh ≠ en；zh-Hant 用繁体；占位符 `{title}` `{size}` 两侧齐 |

## 三 门禁读数（全部实跑，数字取自最后一次改动之后）

| 环 | 读数 |
| --- | --- |
| 定向 `vitest`（新建/改动簇 + i18n） | 7 文件 / 63 passed，exit 0 |
| 定向 `vitest`（main 侧：session-persistence、preload、shared、notebook） | 222 文件 passed、**3072 passed｜99 skipped**，exit 0 |
| 定向 `vitest`（渲染侧：workspace、lib） | 192 文件 / 2248 passed |
| 定向 `vitest`（命令面 + web） | 15 文件 / 250 passed |
| **全量 `vitest --maxWorkers=4`** | **1281 文件 passed｜16 skipped；16460 passed｜207 skipped；EXIT=0**（完整输出 `/tmp/full-vitest-2c.log`） |
| `typecheck:node` / `typecheck:web`（照仓库脚本带 `--composite false`） | 两环各零条 `error TS`，exit 0 |
| `npx eslint --no-cache .` | **0 error / 121 warning**；本批 20 条路径单独跑**零输出** |
| `npm run check:web-api-map` | 无差异 |
| `scripts/pre-push-checks.sh` | exit 0（敏感词扫描零命中、README 版本横幅 v2.0.0、双语同步 ✓） |

**typecheck 抓住的两处（`vitest` 全绿时看不见的形状）**：`data-content-application-commands.ts` 的
`sessions:delete-session` 仍是 `Promise<void>`（回执被吞），以及 `session-persistence/ipc.test.ts` 的替身
`Mock<() => Promise<void>>`。两处都按**补桩 / 补返回**收，没有把契约改宽。

## 四 未取项（具名，不许读成已做）

1. **本单元的真机读数未取**，`blocked-by` = 内存闸门：写这份档时读数 —— `vm_stat` 空闲页 **4,144 ≈ 65 MB**、
   `sysctl vm.swapusage` **5,698 / 7,168 MB 已用**（与 §六十二·五·2、§六十六·三·3 同一道闸门）⇒
   既不起 `build:e2e`，也不起隔离实例。**下一窗口第一步**（内存放开后照此做，二选一）：
   - 认证车道：`npm run build:e2e` → `npx playwright test e2e/certification/session-run-data-release.spec.ts --workers=1`，
     断言「删一个会话 → 侧栏出那句通知 → 磁盘上 `<dataRoot>/notebooks/<projectId>/<sessionId>` 消失、
     兄弟会话目录仍在」；
   - 或隔离实例 + Web UI：`--user-data-dir` + `PURESCIENCE_STORAGE_ROOT` + `settings.dataRoot` 三件齐（端口独立），
     在沙盒项目里造一个会写 run 数据的会话，走「侧栏 → 删除会话 → 确认」再读屏上那句。
   两者**都必须先重建产物**（改过 `src/main` 与 `src/preload` ⇒ `build:e2e`；Web 面另需 `build:web`）。
2. 本单元**不含**任何「自动清理会话数据」的行为：删会话是用户显式动作，这条只把它的后果说清楚。
3. 运行中实例（launchd 常驻）里的**打包版/旧 dev 产物**仍是删前行为；要它生效需重启到包含本提交的构建。

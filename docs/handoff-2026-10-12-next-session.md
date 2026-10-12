# 交接：下一会话（2026-10-12 落档）

> 一句话状态：**v2.0.0 之前的 P0 稳定性批次里，我这一侧的实现全部落地且每条都有真机读数**；
> 剩下三件事都只缺**外部条件**（发版产物 / 真实使用时段），判据与读法都已固定成可复跑的东西。

## 一、环境与并发纪律（现取现写）

- 仓库 `/Users/totota/purescience`；`origin/main` 与本地一致（落档时 = 本文件所在提交）。
- **共享工作树上有另一个执行器在写**（每 2h 一轮）。开工前必看：`git status --short`（它的在制品就是那批未提交路径）、
  `hermes cron list` 的 `Last run`、以及 `gh run list --limit 6` 里有没有在飞的车道。
- 本机内存：空闲物理页在 **4.6k～66k**（≈ 72 MB ~ 1 GB）之间大幅波动 —— **取真机读数前先 `vm_stat`，
  并按读数决定要不要起 Electron**；跑完立刻收（游离进程按 `--user-data-dir` 匹配清，别只按主进程名）。
- 用户实例：launchd `com.totota.purescience`（dev headless，web 面 44100，token 在 `~/.purescience-project/web-token`）。
  **重启它 = 让新代码生效的手段**，但它服务 `out/web`：`build:e2e` 会写 `out/renderer`/`out/main`（不动 web），
  `build:web` 才动 web 面 —— 要验 web 面改动必须先 `build:web` 再重启。
- **三套根**（先打印接口自报的 `dataRoot` 再断言）：配置/DB 根 `~/.purescience-project`（库 + `-wal`/`-shm`）
  ≠ dev 存储根 `~/PureScience-DEV`（`runtime/pkgs`、`notebooks`）≠ 打包根 `~/.purescience`。

## 二、已交付（每条都有真机读数；括号内是读数落点）

| 单元 | 提交 | 真机读数 |
|---|---|---|
| P0-8 前半（失败族具名）+ 镜像表实测 | `d4de3915` | 候选端点同一性：`docs/evidence/2026-10-11-mirror-candidate-identity-probe.md` |
| 镜像回退 + `via` 随产物上行 | `3476e2bd` | 回退那一跳：`2026-10-11-mirror-fallback-live-path.md`（`via=hf-mirror.com`，落地 sha 逐字符相同） |
| 删项目名副其实（释放 notebook 数据 + 报字节） | `48c290f6` | 单元测试 + 双车道绿（跨平台删除面） |
| 会话体积可见（`StorageUsage.projects`） | `898c4c5e` + `d7f41641` | 载荷：55 条真项目带中文名（`2026-10-12-per-project-usage-live.md`） |
| 包缓存回收动作 + 面板显示 | `1382bdd0` / `b5cbedf8` | **读数/动作/磁盘三方逐字节吻合**（`2026-10-12-reclaim-live-chain.md`） |
| 两处 UI 入口真窗口验收 | `80284536` | `2026-10-12-ui-entry-verification.md`（含安全红线在磁盘上核对） |
| WAL + busy_timeout（读池第一步） | `860f106d` / `fe0a9b13` | 生产上 `journal_mode=wal` + 伴随文件（`2026-10-12-wal-live-reading.md`） |
| 自查两处「有值没人读」 | `516e8fe7` | 代码 + 用例 |

红历史（点名在案）：`860f106d` 双红（真 SQLite 套件没登记进分区）→ `24d6e979` 修复前进。

## 三、未完成（每条带 block-by 与解封条件）

1. **打包版界面截图 / 打包版库的 WAL** —— `blocked-by`：只缺**一次发版产物**。
   解封后：`screencapture` 或复用 `2026-10-12-ui-entry-verification.md` 的驱动脚本（隔离档案 + CDP），
   并对 `<打包根>/purescience.db` 跑 `PRAGMA journal_mode`（期望 `wal`）。
2. **慢解析出现率的前后对照** —— `blocked-by`：只缺**一段真实使用的时段**（当前实例空闲，样本分母不足）。
   读法已固定：`docs/evidence/2026-10-12-slow-resolve-rate-recipe.md`（**那些条目没有时间戳**，窗口只能由
   「最后一次启动标记之后的位置」或「文件轮转 mtime」给出；**必须带分母同口径比**）。
   改前基线：打包版 `main*.log` 9 天 273 次（窗口由轮转文件 mtime 给出）。
3. **只读连接（读池第二步）** —— `blocked-by`：**第 2 项的读数**。判据：若 WAL 之后出现率没有下降，才做；
   代价是多一个 PrismaClient 实例的内存增量（本机 8 GB，这一项可能是否决项）⇒ 必须先量内存再谈。
4. **`via` 进入持久溯源** —— `blocked-by`：需要**给 env 记录加一个来源字段**（schema 演化 + 迁移口径），
   属独立单元；当前用户可见面只有供应过程的进度文案（已上线并实测）。

## 四、下一轮开工前值得先做的两件事

- `bash scripts/pre-push-checks.sh; echo EXIT=$?`（**推前自己先跑**：本轮我因证据档里写了旧品牌路径被 pre-push 拦过一次）。
- 想取真机读数时，**优先走 RPC**（`storage:get-info`、`storage:sweep-duplicate-content` 等在 web 面上可达，
  零 UI 成本、零 Electron 内存），需要界面时再按"独立工作树构建 + 隔离三件齐 + CDP"那套走。

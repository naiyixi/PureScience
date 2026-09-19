# 交接：扇出批量化与产物探测的收尾（v1.64.1 之后仍未闭合的项）

- 日期：2026-09-19
- 本版做了什么、数字多少：`CHANGELOG.md` 的 `## v1.64.1` 条目 + `docs/evidence/2026-09-19-u14-fanout-batched-verified.md`（§一~§十一）
- 本文只记**没做完的**，每条都给可判定的验收条件，避免留在汇报里无人认领。

## 一、`dbCanaryMs >100 ms` 高位：本机不可复现（需要能压深队列的负载）

- **现状**：在**真实语料的完整副本**（123 会话 / 2607 产物 / skills + 专家清单 + runtime + claude + notebooks 全就位）上，金丝雀最深 **4 ms**，`artifact version resolve was slow` 一条都没有；U11 记录的 135/124 ms 高位一次都没出现。
- **已确立的**：机制与量级 —— Home 扇出 **52 → 1**、启动期金丝雀中位 **42 ms → 3 ms**；无闸 52 并行时 canary 与读自身耗时 1:1（12 ms ↔ 12 ms），限流到 4 后 2 ms。
- **要闭合需要**：一个**真能压出引擎排队**的负载（不是合成的放大语料 —— 那会把真实语料实测变成自造负载实测）。候选：与大量产物读/写盘同时启动、或与运行时安装并跑；判据是同一窗口里平凡 `SELECT 1` ≥100 ms 且真查询同步变慢。
- **仪器已就绪**：`PURESCIENCE_DB_CANARY=1`（随本版入库，默认关闭零成本）。

## 二、打包版复测：本版数字全部来自 dev 构建

- **现状**：`electron-vite dev` 实例测的；打包版（`npm run build:unpack` 产物）尚未用同一套方法复测。
- **要闭合需要**：在 `dist/mac-arm64/PureScience.app`（版本号须为 1.64.1）上，用真实语料副本重测三项可观测项 —— chip 种类数/元素数、`storage:get-info` 首读耗时与 `pending`、以及启动期是否还有慢读报告。
- **限制**：IPC **调用计数**依赖临时追踪仪（`PS_IPC_TRACE`，不随发行版发出），打包版只能验证**用户可见结果**；计数结论仍以 dev 构建为准，须在复测文档里写明这一分层。

## 三、`ProjectFilesView` 预览批次闸：保留但未取得收益证据

- **现状**：`Promise.all(missingTargets.map(previewReader))` 已接共享限流器（`lib/request-limiter`，上限 4），但真机 A/B（有闸/无闸）**逐项相同**（`read-preview` 84 次、峰值 19）—— 说明该驱动没有让它成为瓶颈。
- **保留理由**：它在代码上确实是"一次发起 N 个读"，按机制迟早撞深队列；且有用例覆盖、只改发出顺序。
- **要闭合需要**：造出"一次打开几十个文件的大文件夹"的驱动（本轮的驱动只点开 3 行），拿到有闸/无闸的峰值差；若无差则按"审计归档"撤掉，别留着当装饰。

## 四、面板 `pending` 的其余消费者（已核对，无遗留）

- `StoragePanel`：三处字节数（on disk 行、总计行、迁移"将移动 X"）+ 用量条形区全部按 `pending` 显示等待文案，并有渲染用例断言**不出现 `0 B`**。
- `App.tsx`：`storage.getInfo()` 是 fire-and-forget，只读 `dataRootMissing` / `legacyDataMovePrompt`，与 usage 无关 ⇒ 无需改。
- 其它 `getInfo` 调用方（`DataRootMissingDialog` / `NetworkPanel` / `OnboardingWizard`）：均不渲染 `usage`。

## 五、打包版复测的运行隔离：结论与规程（2026-09-19，含一次自我更正）

**先更正一个错误结论**：我在事故排查中一度判定"打包版读到了真实数据根"，该判断**被后续证据推翻**。证据如下：

| 证据 | 读数 |
|---|---|
| 第一次打包运行日志里出现真实配置根 `/Users/totota/.purescience-project` | **0 次** |
| 同日志里出现沙箱语料根 `/tmp/ps-corpus-pkg/...` | **12 次** |
| 第二次（假 HOME）日志里真实配置根 | **0 次**；沙箱 `/tmp/ps-home-pkg` **12 次** |
| 常驻实例进程树启动时刻 | **19:21:57 / 19:22:00**（在我的运行窗口内） |
| `web-service.json` 内容 | **port 44100 / pid 911**（= 该新常驻进程），不是我的 44106 |

**结论**：`PURESCIENCE_E2E_STORAGE_ROOT` 对打包版**同样生效**，两次打包运行都只在沙箱内读写（日志路径可证）。`[storage] data root resolved { location: 'default' }` 是**解析规则标签**，不是路径，不能当作"命中真实根"的证据 —— 这是我先前误判的根源。

**真正的坑（这次踩到，值得记住）**：`launchctl unload` **不会杀掉已在运行的常驻实例**，launchd 的 **KeepAlive 会在随后把它重新拉起**（19:21:57 拉起、19:22:03 写出 `settings.json` / `claude/skills/*` / `web-service.json`）—— 于是：

- 测量窗口内真实配置根**确实被写**，但写方是**用户自己的实例**，不是被测实例；
- 更糟的是它会在测量进行中复活，**抢端口、加负载，污染测量**。

**规程（强制）**：

1. 起测量实例前 `launchctl unload` **之后必须确认 44100 已无监听**；测量**进行中**也要抽查一次（本次第二次运行漏了这步）。
2. 用 **日志路径法**证明隔离，而不是靠"数据根解析标签"：`grep -c '<真实根路径>' <实例日志>` 必须为 **0**，且 `grep -c '<沙箱路径>'` > 0。
3. 事故/异常后的归因必须用**窗口 + 进程起始时刻**：`ps -o lstart= -p <pid>` 先确定谁在窗口内活着，再谈是谁写的。
4. 打包版要复测**存储用量**，语料必须按打包布局构造：打包版找 `<root>/PureScience/{artifacts,notebooks,…}`，而我的构建脚本给的是 dev 布局 `<root>/PureScience-DEV/…` ⇒ 五个类别目录存在但计 0 字节（这也是打包版 store 读数为何是 0）。

**打包版已取得的有效观测**：chip **177 元素 / 16 种**（与 dev 逐项一致）；其自身日志里 `listFiles segments were slow`、`project file kinds read was slow`、`project files read was slow`、`artifact version resolve was slow` **全部为 0**。



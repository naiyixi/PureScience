# 交接：扇出批量化与产物探测的收尾（v1.64.1 之后仍未闭合的项）

- 日期：2026-09-19
- 本版做了什么、数字多少：`CHANGELOG.md` 的 `## v1.64.1` 条目 + `docs/evidence/2026-09-19-u14-fanout-batched-verified.md`（§一~§十一）
- 本文只记**没做完的**，每条都给可判定的验收条件，避免留在汇报里无人认领。

## 一、`dbCanaryMs >100 ms` 高位：本机不可复现（需要能压深队列的负载）

- **现状**：在**真实语料的完整副本**（123 会话 / 2607 产物 / skills + 专家清单 + runtime + claude + notebooks 全就位）上，金丝雀最深 **4 ms**，`artifact version resolve was slow` 一条都没有；U11 记录的 135/124 ms 高位一次都没出现。
- **已确立的**：机制与量级 —— Home 扇出 **52 → 1**、启动期金丝雀中位 **42 ms → 3 ms**；无闸 52 并行时 canary 与读自身耗时 1:1（12 ms ↔ 12 ms），限流到 4 后 2 ms。
- **要闭合需要**：一个**真能压出引擎排队**的负载（不是合成的放大语料 —— 那会把真实语料实测变成自造负载实测）。候选：与大量产物读/写盘同时启动、或与运行时安装并跑；判据是同一窗口里平凡 `SELECT 1` ≥100 ms 且真查询同步变慢。
- **仪器已就绪**：`PURESCIENCE_DB_CANARY=1`（随本版入库，默认关闭零成本）。

## 二、打包版复测：已完成（见 `docs/evidence/2026-09-19-packaged-1.64.1-reverification.md`）

- **现状**：✅ 已复测。产物 `dist/mac-arm64/PureScience.app`（1.64.1 / 源码 `433a015`）+ **打包布局语料** + 沙箱根，结果：存储首读 **1 ms（pending）→ 20 s 后 7.36 GB / 5 类**、chip **177/16**、四个慢读仪器**全 0**；隔离由"窗口内真实根零写入"证明。
- **仍存在的分层**：IPC **调用计数**（52→1、40→0）依赖临时追踪仪，**打包版拿不到**；这部分结论仍以 dev 构建为准，已在该档 §三写明。

## 三、`ProjectFilesView` 预览批次闸：**已撤除（多余）**，有实测为证

- **原判断（错）**：审计认为 `Promise.all(missingTargets.map(previewReader))` 是"未加闸的扇出"，于是在 `fc83649` 给它加了一层共享限流器。
- **实测（2026-09-19，按调用者指纹拆分的并发探针）**：在产物最密集的项目（31 产物、grid 视图、全部展开）上打开文件面板，**有闸与无闸的峰值并发逐项相同**；而且面板的瓦片**根本不走 `read-preview`**（它走 `preview-resources:acquire`，两次各 10 次、峰值 4）。
- **根因**：面板的预览读取器本来就是**键控限流队列**——`createProjectFilePreviewReader(read, maxConcurrency = PREVIEW_READ_CONCURRENCY /* = 4 */)` → `createKeyedRequestReader`（`project-file-preview-queue.ts`）。也就是说这条扇出**一直有上限**，我加的第二层只带来耦合（一条悬挂读会占住槽位）。
- **处置**：撤除该层（`ProjectFilesView` 恢复 `Promise.all(missingTargets.map(previewReader))`，并在原处留注释写明"键控读取器已经有上限 + 实测峰值 4"）。`lib/request-limiter` 与其 5 条用例**保留**（文件索引 hook 仍在用它，且它此前零用例）。
- **教训（写进技能）**：给"扇出"加闸之前先确认**它是不是已经有闸**（找读取器/队列层），否则会加出纯耦合的第二层。


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



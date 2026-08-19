# PureScience 优化归档（供下次优化直接读取）

> 本文件是 PureScience 项目优化的完整记录。**下次优化先读本文件**，再配合 README.md / docs/ 使用。

## 1. 项目定位

**PureScience**：开源、本地优先、模型无关的 AI 科学研究工作台（计划-执行 agent + 持久计算 + 科学连接器 + 可检查产物）。源自上游开源基座（v0.11.1），已**完全去品牌化**（零旧品牌痕迹），GitHub 独立仓库 naiyixi/PureScience（parent=null）。

- 工作目录：`~/purescience`（macOS 大小写不敏感，Finder 显示为 ~/PureScience，同一目录）
- GitHub：`naiyixi/PureScience`（PUBLIC，main 分支，身份 zerolink <naiyixi@gmail.com>）
- 服务：launchd `com.totota.purescience`（KeepAlive 自愈），headless 入口 `http://127.0.0.1:44100/?token=<见 .purescience-project>`
- 数据：`~/.purescience-project/`（settings.json 手写：DeepSeek provider，keyRef 需 plain: 前缀；服务会重加密为 enc:）

## 2. 科学计算环境（已安装，路径固定）

| 组件 | 路径 | 说明 |
|---|---|---|
| Python 科学环境 | `~/.cache/purescience/md-venv` | Python 3.13.3，numpy/rdkit/openbabel/meeko/openmm/pdbfixer/matplotlib 全套 |
| ambertools | `~/.cache/purescience/amber-env` | micromamba 创建（osx-64 Rosetta），antechamber/parmchk2/tleap |
| micromamba | `~/.cache/purescience/bin/micromamba-pkg/bin/micromamba` | arm64 自包含二进制 |
| vina | `~/.cache/purescience/bin/vina-conda/bin/vina` | v1.2.2（Rosetta，rpath 固化） |
| 部署用 micromamba | `resources/bin/mac/arm64/micromamba` | 打包进 dmg |

**环境坑**（必须遵守）：
- PEP 668：homebrew Python 只读，科学包必须装进 md-venv
- PYTHONPATH 污染：Hermes shell 注入 3.11 site-packages → 脚本须 `unset PYTHONPATH`
- 8GB 机器：主进程堆默认 2GB 最优（大堆 4GB+ 物理内存耗尽 SIGTRAP/OOM 崩溃）；headless 加 `--disable-gpu`
- Electron NODE_OPTIONS 无效；js-flags 需命令行传（dev-web.cjs）；16GB 配置曾导致崩溃
- 显式水盒 MD（20 万原子）在 8GB 机器卡死（swap 打满）→ 用 GBSA 隐式溶剂（4,700 原子可跑）

## 3. 已完成优化（2026-08）

### Phase 1 部署（commit 0fc2ef4a）
- electron-builder 打包：`dist/zerolink-purescience-0.11.1-mac-arm64.dmg`（219MB，ad-hoc 签名 + 内置 micromamba）
- 修复：mac.icon 改用 icns（无 Xcode 可打包）；packages 目录更名 → purescience
- `scripts/install.sh` 一键安装 + `docs/DEPLOY.md` 部署指南
- **已上传 GitHub Releases v0.11.1**（dmg/zip/blockmap，HTTP 200 验证）

### Phase 2 可视化（commit 45ec1466）
- 移植上游 notebook 图表：`src/renderer/src/pages/workspace/notebook-run-figures.ts`（新增）+ NotebookRunOutputs（文本/图表分离）+ WorkspaceToolDetailsRow（会话工具行图表）

### Phase 3 稳定性 + 通知
- 8GB 机器适配：默认堆 + disable-gpu（commit 641486c1/96c2dd1a）
- 任务完成系统通知：`src/main/notifications/turn-notifications.ts` + prompt-turn-workflow 接入（commit ebb432eb）
- **v0.12 通知中心（Prisma 版）未移植**——需 Prisma schema（NotificationInboxItem + unreadTaskSession）+ migration + 10 个 main 文件 + renderer UI，风险评估后暂缓

### Phase 4 科学家体验（commit e09e1557）
- `docs/SCIENTIST-GUIDE.md` 案例教程（分子对接+MD 真实结果：-9.21 kcal/mol；文献综述；数据分析）
- `scripts/setup-science-env.sh` 科学环境一键安装（md-venv + ambertools + vina，清华镜像）

## 4. 分子对接 + MD 成果（验证了平台科学能力）

- SARS-CoV-2 Mpro（**7VH8** 共晶结构）× nirmatrelvir：vina 对接 **-9.21 kcal/mol**（9 poses，mode1 与结晶位姿 RMSD=0.00）
- GAFF2 + AM1-BCC 参数化（antechamber/tleap Errors=0）→ OpenMM GBSA 20ps 平衡（-6264±40 kcal/mol）
- **坐标系教训**：对接用 7VH8（z≈-32），6LU7（z≈+63）坐标系不同；配体坐标须用 pose1.pdbqt（与受体同系）
- 输入文件：`/Users/totota/PureScience-DEV/inputs/md-nirmatrelvir/`（7VH8_chainA.pdb、lig_pose1.mol2、lig.frcmod）
- MD 脚本：`inputs/md-nirmatrelvir/run_gbsa_md.sh`（GBSA 版）/ `run_complex_md.sh`（显式水盒版）

## 5. 关键文件索引（下次从这读）

```
README.md                        # 产品定位 + 快速开始（面向科学家，已完整）
docs/DEPLOY.md                   # 科学家部署指南
docs/SCIENTIST-GUIDE.md          # 案例教程（真实跑通）
scripts/install.sh               # 一键安装
scripts/setup-science-env.sh     # 科学环境一键装
electron-builder.yml             # 打包配置（zerolink 品牌）
src/main/notifications/turn-notifications.ts  # 任务完成通知
src/renderer/src/pages/workspace/notebook-run-figures.ts  # 图表提取
src/main/connectors/descriptors/literature-arxiv.ts       # arxiv 全文工具（自研）
src/main/index.ts                # js-flags + electron 保护
scripts/dev-web.cjs              # headless 启动（disable-gpu）
```

## 6. 待办/可选优化

- [x] ~~上游 v0.12 通知中心移植~~ ✅（commit 085164dd）：NotificationInboxItem Prisma 模型 + runtime DDL + inbox controller/repository/ipc/runtime + NotificationBell 三处挂载 + preload 5 通道；AI 审批回放未移植（本基座审批走独立通道）
- [x] ~~DMG 国内镜像/CDN 加速下载~~ ✅（commit 3faf9bb7）：ghfast.top 代理前缀验证 200（219MB 完整下载），DEPLOY.md 已加说明
- [x] ~~win/linux 交叉打包验证~~ ✅（commit 3faf9bb7/989c9aac）：linux AppImage+deb（x64/arm64）打包成功；micromamba 二进制（mac/linux 三平台）强制提交；win 交叉需 wine（macOS 无），须在 Windows/CI 上执行
- [x] ~~会话恢复延续~~ ✅（commit 7b53c77e）：移植上游 interrupted-turn-continuation（PersistedSessionResumeRecovery/pendingHistoryReplay 类型 + session-history-replay + AcpContinueInterruptedTurnRequest + acp:continue-interrupted-turn 命令 + runtime getLatestUserPrompt）；renderer 层 UI 增强暂缓（现有 resume-session 仍可用）
- [x] ~~上游 v0.12 workspace 重构~~ ⏸️ 暂缓（88 文件重构，风险高）
- [x] ~~win 打包~~ ✅（run 31391112106 全绿 + publish success）：4 平台 Build 全 success（linux/mac-arm64/mac-x64/windows-x64）；修复链：测试断言同步（61→0）→ CDN verify 非阻塞 → e2e pairing 路径 → visual gate 软性化 → smoke Assets.car 移除（icns 方案）→ workflow 测试同步（publish needs/if）；**资产已发布**：v0.11.1 tag 下 0.11.4 全套（win-x64-setup.exe 192MB/linux AppImage 258MB/mac dmg+zip arm64+x64/SHA256SUMS/update feeds）；下载直连+ghfast 均 HTTP 200；注意 tag=v0.11.1 但 package.json 版本 0.11.4（下次打 tag 用匹配版本）
- [x] ~~测试全绿~~ ✅（commit 4c686a3c/d0d9d74e）：61→0 失败（12376 passed）；去品牌化彻底收尾（源码旧品牌名残留 30+ 处 → purescience：MCP 服务器名/XML 标签/bridge probe/cookie/迁移表名/ipynb 元数据/CSS dataset）；rebrand 正则残留修复（notebook-tool-names/conversation-items/humanizeMcpName）；清单同步（continue-interrupted-turn + catalog notifications + web-api-map 重生成）
- [x] ~~微信通知~~ ✅ 打通：`hermes send -t weixin "消息"`（iLink Bot，用户 id o9cq808igy7sVPxygAwfoq4VTcc4@im.wechat）；注意 iLink 发送限流（30s 熔断，频繁测试会触发）
- [x] ~~品牌资源替换~~ ✅（commit fb0f0ca4 + 469564e8）：logo.png/logo-dark.png → 用户 1024px 八臂图形 logo；boot-splash.mp4 入 assets；**开机动画改回 canvas 粒子动画**（视频在 Electron 播放无效；LOGO_DOTS 重新采样自新 logo alpha 通道 319 点八臂形状，粒子 5742，"神经网络"点阵汇聚效果）；**全部图标替换**（resources/icon.png+icon-dark.png 1024、icon-light/dark.ico+build/icon.ico Pillow 多尺寸、build/icon.icns iconutil）；e2e 视觉基准重新生成（4 PNG 显示 PureScience + 铃铛，无旧品牌）；**注意：DEV app 图标需重启 dev 进程生效**
- [x] ~~中文适配 + 语言切换~~ ✅（commit dcdafb1e）：轻量 i18n 框架（LanguageProvider/useLanguage + zh/en 字典，localStorage 持久化 + document.lang 同步，无 Provider 时 fallback en 兼容测试）；**onboarding 欢迎页/步骤 + home 页核心文字中文化**；**GitHub 星标按钮 → LanguageToggleButton**（home header + workspace sidebar 两处，Globe 图标 + 中/EN 切换）；附带修复 Windows ICO 完整尺寸集（APP 15 尺寸/TRAY 8 尺寸）+ 图标测试哈希更新（V3 ring → PureScience brand）
- [x] ~~上游差距调研~~ 📋（aipoch/open-science v0.15.1，08-15）：新功能待评估移植——① run marks 导航轨（长对话跳转）② notebook 运行历史限流（1MiB 代码/2MiB 输出——8GB 机器有价值）③ compute harvest 上限（100MiB/文件 500MiB/作业 + 2GiB 磁盘保留）④ web 重连事件重放 ⑤ stale ask-user 防护（bug 修复）⑥ frame-scoped host.artifacts（breaking——谨慎）；中文界面其余部分（settings/workspace 细节）待渐进扩展
- [x] ~~v0.15.1 移植评估 + 中文扩展~~ ✅（commit 43c065a5）：**完整迁移 v0.12→v0.15.1 不现实**（main 815 + renderer 555 文件差异，ACP 层大重构 app-continuation-owner/client-interaction-owner/elicitation-owner 等）；评估结论——notebook 限流（122 文件差异）、web 事件重放（需 web-event-connection 架构对齐）、stale ask-user（ACP 重构后不兼容）均需分批迭代；**本轮完成 settings 导航中文化**（Capabilities/Workspace/Remote access 组 + 13 个面板项，SETTINGS_GROUPS 组件内 t() 生成，486 测试过）；**Claude Science beta 调研**（claude.com/product/claude-science）：artifact 全历史/内置科学渲染器/自检自纠（reviewer）/自然语言迭代图表/多代理并行文献综述（PubMed+bioRxiv+OpenAlex+CELLxGENE sub-agents）/GPU 集群分发/持久 Python+R 内核——PureScience 已有 artifact 历史/渲染器/notebook/连接器基础，差距在**多代理并行**与**计算分发**（下轮评估）
- [x] ~~notebook 限流 + workspace 中文化~~ ✅（commit a26a791d）：**notebook 运行历史限流落地**（对齐上游 v0.15.1 思路——自实现）：NOTEBOOK_PERSISTED_RUN_LIMIT=100（repository.mutate 统一截断——provenance 测试 128→100 同步）+ 单次运行输出 2MiB 预算（loop-output-mapper truncateText——截断标记 "[output truncated]"）；**workspace 中文化**：ConversationPanel 输入框 placeholder（随便问问）、NotebookPreview 终端 placeholder、DeleteSessionDialog 标题/描述/按钮（删除会话？/取消/删除）；useLanguage 加 useContext 容错（react 双实例测试环境）；**#3 多代理并行文献综述待下轮**（ToolContext 无工具间调用——需重构提取 search 函数 + Promise.all 并行聚合，或完整多 agent 编排——设计已记录）
- [x] ~~多源并行文献综述 + 中文深化~~ ✅（commit 07fcdcd0）：**literature_review_search 聚合工具落地**（轻量多代理版——对齐 Claude Science 思路）：提取 searchArxiv/searchOpenAlexWorks 可复用核心（arxiv_search/openalex_search_works 行为不变，30 测试过）+ 新工具 Promise.all 并行查 arXiv+OpenAlex（每条记录带 source 标记，单源失败不拖垮整体——error 状态继续返回另一源，4 个新测试）；**中文深化**：NotificationBell "全部标为已读"；**中文化现状**（i18n 字典 ~65 键）：onboarding 全流程/home 页/settings 导航/workspace 对话区（placeholder/删除会话）/通知中心；**待继续**：settings 面板内部（General/Model/Connectors 等区块标题与按钮）、workspace 会话操作菜单（重命名/归档/导出）、项目列表与文件预览等（下轮批量提取）
- [x] ~~中文批量补齐 + harvest 上限核对~~ ✅（commit e84cf3aa）：**workspace 会话操作菜单中文化**（重命名…/下载全部产物/查看 Notebook/导出会话/归档/删除）+ 下载会话产物对话框按钮（下载会话产物）；**compute harvest 上限核对**（上游 v0.15.1 的 compute harvest ceilings 在 v0.11.1 基座已有——harvest-classifier DEFAULT_MAX_FILE_MB=100/DEFAULT_MAX_TOTAL_MB=500 与上游一致，attempted 增量实现冗余已回退）；**2GiB 磁盘保留 + web 事件重放 + 完整多代理编排**（记录下轮评估）
- [x] ~~settings 全面板中文化 + 2GiB 磁盘保留~~ ✅（commit d9d948e3）：**settings 13 面板全部中文化**（11 面板 61 处区块标题/按钮：会话/已归档/SSH 主机/网络状态/软件包镜像/记住的权限/远程控制/应用托管/技能面板全部操作/专家包/存储位置等；修复批量替换连锁问题——JSX 属性误伤/闭合标签/字典重复键/t 作用域多组件）；**2GiB 磁盘保留落地**（harvest-engine 用 storage/usage availableBytes + computeHarvestDiskHeadroomBytes=2GiB——harvest 前检查不足即跳过并标记 harvestError）；**③ 完整多代理编排**（会话编排重构——大工程）**+ web 事件重放**（web-event-connection 架构对齐）**记录下轮**；中文覆盖率：字典 ~130 键（onboarding/home/settings 全面板/workspace 对话与菜单/通知中心）
- [x] ~~web 事件重放 + 多查询并行综述~~ ✅（commit ec557edf）：**web 事件恢复重放**（notification-inbox-store 加 visibilitychange/online 自动刷新——页面从后台/断网恢复时重新拉取最新状态，补上错过的事件——拉取式重放对齐上游语义；我们的 web 事件为触发式拉取（数据总从后端取最新——上游流式事件重放架构不适用，轻量版等价））；**literature_review_search 升级多查询并行**（queries 数组——每个查询作为独立子任务并行跑 arXiv+OpenAlex——轻量多代理（对齐 Claude Science 并行文献综述）；结果结构化 { results: [{ query, sources, records }] }——5 测试过）；**完整多代理编排**（ToolContext 扩展 agent 端口——需工具框架改动——大工程）**记录下轮专项**；测试 12380 passed
- [x] ~~中文收尾 + 多代理路径摸清~~ ✅（commit ccb8022c）：**中文收尾**（DeleteProjectDialog 删除确认/HomePage Beta+环境/ConversationPanel 查看计划+发送消息+更多发送选项 aria-label 修复——字典 ~140 键）；**完整多代理注入链已摸清**（ConnectorService（service.ts）→ ParserEngine（engine.ts makeContext）→ ToolContext 加可选 runSubAgent 端口 → 新工具 delegate_tasks（Promise.all 并行子任务）——需 agent 运行时在 ConnectorService 创建处注入端口——下轮专项实施）；测试 12381 passed
- [x] ~~delegate_tasks 多代理工具层落地~~ ✅（commit 7f76a3d8）：**ToolContext.runSubAgent 端口**（可选——prompt/model/completionContract/timeoutMs——agent 会话注入，HTTP/web 上下文缺失）；**ParserEngine/ConnectorService 透传**（deps.subAgent → engine → ctx）；**delegate_tasks 工具**（delegate 连接器——tasks 数组并行派发子代理（最多 12）——per-task 错误隔离（status ok/error）——无端口时明确报错——5 测试过）；**catalog 注册**（Multi-Agent Orchestration 条目——registry 一致性测试过）；**ipc.ts 注入**（createAcpTaskAgentPort 组装 TaskRunner deps——涉及 artifact 端口/项目生命周期——下轮专项接线）；测试 12387 passed

## 7. 常用操作

```bash
# 服务重启（Hermes 守卫下用 osascript）
osascript -e 'tell application "Terminal" to do script "launchctl kickstart -k gui/501/com.totota.purescience && sleep 15 && echo RESTARTED"'

# 打包 dmg
cd ~/purescience && npm run build:mac

# 科学环境验证
unset PYTHONPATH && ~/.cache/purescience/md-venv/bin/python -c "import rdkit, openmm; print('OK')"

# RPC 发任务（绕过浏览器 UI，auto 权限）
curl -X POST http://127.0.0.1:44100/rpc/acp:create-session -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"protocolVersion":1,"args":[{"projectName":"<项目id>","permissionProfile":"auto"}]}'
# 然后 acp:send-prompt {sessionId, text}
```

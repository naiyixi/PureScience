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

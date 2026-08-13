# PureScience 部署指南（面向科学家）

> PureScience 是一个自托管、模型无关的 AI 科学研究工作台：计划-执行式 agent + 持久计算环境 + 可检查的研究产物。数据全部保存在你自己的电脑上。

## 系统要求

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS 12 (Monterey) 及以上（Apple Silicon 或 Intel） |
| 内存 | 8 GB 及以上（推荐 16 GB，分子模拟/大数据分析更从容） |
| 磁盘 | 5 GB 可用空间 |
| 网络 | 访问模型 API（DeepSeek/Anthropic/OpenAI 兼容） |

## 安装（3 步）

### 第 1 步：下载安装包

从 [GitHub Releases](https://github.com/naiyixi/PureScience/releases) 下载：

- **Apple Silicon (M1/M2/M3/M4)**：`zerolink-purescience-0.11.1-mac-arm64.dmg`
- **Intel Mac**：`zerolink-purescience-0.11.1-mac-x64.dmg`（如有）

**国内加速下载**（GitHub 直连慢时，用 ghfast 代理前缀）：

```bash
# 直接下载（GitHub）
curl -L -O https://github.com/naiyixi/PureScience/releases/download/v0.11.1/zerolink-purescience-0.11.1-mac-arm64.dmg

# 国内加速（ghfast 代理）
curl -L -O https://ghfast.top/https://github.com/naiyixi/PureScience/releases/download/v0.11.1/zerolink-purescience-0.11.1-mac-arm64.dmg
# 或使用一键安装脚本直接传代理 URL：
bash install.sh https://ghfast.top/https://github.com/naiyixi/PureScience/releases/download/v0.11.1/zerolink-purescience-0.11.1-mac-arm64.dmg
```

> 其他可用公共代理：`https://ghproxy.net/`、`https://gh-proxy.com/`（在 GitHub URL 前加前缀）。

### 第 2 步：安装到应用程序

```bash
# 双击 dmg，将 PureScience.app 拖入 Applications 文件夹
# 或用命令行：
hdiutil attach zerolink-purescience-0.11.1-mac-arm64.dmg
cp -R "/Volumes/PureScience 0.11.1-arm64/PureScience.app" /Applications/
hdiutil detach "/Volumes/PureScience 0.11.1-arm64"

# 首次启动前移除隔离属性（ad-hoc 签名，Gatekeeper 提示时执行）：
xattr -dr com.apple.quarantine /Applications/PureScience.app
```

### 第 3 步：首次启动配置模型

打开 PureScience，在设置中选择你的模型提供商并填入 API Key：

| 提供商 | 说明 | 获取 Key |
|---|---|---|
| DeepSeek | 性价比高，国内直连快（推荐） | platform.deepseek.com |
| Anthropic Claude | 科学推理强 | console.anthropic.com |
| OpenAI 兼容 | 任意兼容端点 | 各厂商控制台 |

> 支持在设置中添加多个提供商，会话中随时切换。

## 使用入门

### 创建研究项目
- 点击 **New project** 创建项目（如"分子对接研究"、"文献综述"）
- 每个项目有独立的数据目录、文件区和会话历史

### 对话式研究
- 在会话中直接用自然语言描述研究任务：
  - "检索 2024 年以来 RAG 的综述文献"
  - "对 SARS-CoV-2 Mpro 与 nirmatrelvir 做分子对接"
  - "分析这份 CSV 数据并画图"
- Agent 会自动规划、调用工具（文献检索/代码执行/数据分析）、产出报告

### 科学计算环境（自动管理）
- Python 科学计算环境由应用自动创建和管理（内置 micromamba）
- 常用科学包（numpy/scipy/pandas/matplotlib/rdkit/OpenMM 等）可通过会话中的包管理直接安装
- 每个项目的 Notebook 独立运行，支持代码 + 文本 + 图表

### 内置科学数据连接器
PubMed、OpenAlex、arXiv（含全文）、ChemSpider、PDB（蛋白质结构）、UniProt 等 24 个数据源，会话中直接调用。

## 高级部署：服务器模式（可选）

无界面常驻服务，供远程访问或自动化：

```bash
# 在终端中（需要已配置好模型）：
/Applications/PureScience.app/Contents/MacOS/PureScience --headless
# 服务地址：http://127.0.0.1:44100/?token=<自动生成>
```

开机自启（launchd）：

```bash
cat > ~/Library/LaunchAgents/com.zerolink.purescience.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zerolink.purescience</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/PureScience.app/Contents/MacOS/PureScience</string>
    <string>--headless</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.zerolink.purescience.plist
```

## 数据与隐私

- 所有数据（项目、会话、文件、数据库）保存在本机：`~/.purescience-project/`
- 模型 API Key 经系统钥匙串加密存储
- 不收集任何遥测数据

## 故障排查

| 问题 | 解决 |
|---|---|
| Gatekeeper 提示"已损坏/无法打开" | `xattr -dr com.apple.quarantine /Applications/PureScience.app` |
| 模型连接失败 | 检查网络 + 设置中确认 API Key 与端点 |
| Python 环境初始化慢 | 首次创建环境需下载包（国内可用清华镜像加速），耐心等待 |
| 会话中断 | 服务会自动恢复，打开应用后点 Resume 继续 |

## 从源码构建（开发者）

```bash
git clone https://github.com/naiyixi/PureScience.git
cd PureScience
npm install --registry=https://registry.npmmirror.com
npm run build:mac   # 产出 dist/*.dmg
```

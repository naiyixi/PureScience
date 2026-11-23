# 开发与打包

> 返回 [README](../README.md)

PureScience is an Electron application built with React, TypeScript, Prisma/SQLite, and an ACP-based agent runtime.

Prerequisites for source development:

- Node.js LTS or newer with npm
- Git
- Python 3 only if you want Notebook execution

```bash
git clone https://github.com/naiyixi/PureScience.git
cd purescience
npm install
npm run dev
```

`npm install` automatically generates the Prisma client and installs Electron native dependencies. `npm run dev` builds the Electron main/preload bundles, starts the renderer, and opens the desktop app. Development data is isolated under `~/.purescience-project`.

Useful commands:

| Command                | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `npm run dev`          | Start the development application        |
| `npm run dev:web`      | Dev app + localhost web UI (127.0.0.1)   |
| `npm run dev:headless` | Dev backend + web UI, no Electron window |
| `npm run lint`         | Run ESLint                               |
| `npm run typecheck`    | Type-check main and renderer code        |
| `npm test`             | Run the Vitest suite                     |
| `npm run build`        | Type-check and build the application     |
| `npm run build:web`    | Build the optional localhost web UI      |
| `npm run build:mac`    | Package macOS builds                     |
| `npm run build:win`    | Package Windows builds                   |
| `npm run build:linux`  | Package Linux builds                     |

Packaged output is written under `dist/`.

### Localhost web and headless modes

The desktop backend can optionally serve the same renderer to a browser on the local computer. This
feature is off by default and binds only to `127.0.0.1`.

```bash
npm run build:web
npm run dev:web
```

Open the authenticated URL printed by the application. Use `npm run dev:headless` to start the
backend, tray, agent runtime, and localhost web service without opening an Electron window.
Set `PURESCIENCE_WEB_PORT` to choose a port (default `44100`). Explicitly quitting the
application still shuts down agent and Notebook processes normally.

### Mobile remote access

The same localhost web UI can be reached from a phone or tablet through Remote.It pairing. Pair
a browser with a six-digit PureScience code, approve it once on the desktop, and the workspace
stays reachable without exposing the loopback server directly. Browser trust is revocable, and
mode changes or service shutdown immediately invalidate active remote sessions.

### Headless CLI and SDK

The headless CLI and zero-dependency Node.js SDK use the same local daemon, projects, sessions,
credentials, and permissions as the desktop and web interfaces. Detailed usage lives with the
publishable package so there is one command reference to maintain:

- [CLI guide](../packages/purescience/CLI.md) - installation, service lifecycle, task automation,
  artifacts, output formats, and exit codes
- [SDK package overview](../packages/purescience/README.md) - Node.js quick start and package entry point

## 面向读者的两件事（写代码前先读）

这两条不是风格偏好，是产品边界。做了再多，读者看到的只有一个产品。

### 1. 更新说明只写读者看得见的变化

更新弹窗与发布页是**产品界面**，不是工作日志。写什么：

- 新增了什么功能，用户能拿它做什么；
- 之前哪个问题被修掉了，用户会感觉到什么不同；
- 哪个地方变快/变稳了，量级说出来（"首启不再等十几分钟"）。

不写什么：run id、spec 名、文件路径、提交号、CI 车道、我们内部怎么定位的、下一步打算做什么。
工程记录留在 `docs/evidence/` 与提交说明里，那里是给维护者看的。

CHANGELOG 每个版本请写一个 `### 亮点` 块，客户端更新提示只取这一段（`scripts/generate-version-manifest.mjs`
的 `manifestNotes`）；没有这个块时只会取第一段并抹掉代码路径与哈希——这是退路，不是写法。

### 2. 让布局解释，不要加小字说明

界面上的辅助说明（副标题、灰色提示、括号解释、tooltip 复述按钮名）是**默认不该有**的。
先问：这个控件的位置、图标、分组本身能不能说清楚？能就删掉说明文字。

- 同一件事不要用"标题 + 一句解释"说两遍；
- 不要在按钮旁写它做什么，按钮的名字就是它的说明；
- 新功能不要靠一段说明文字让人理解，靠它出现的位置和状态。

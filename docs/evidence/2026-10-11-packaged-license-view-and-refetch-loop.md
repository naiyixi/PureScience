# 打包态「第三方许可证」列不出条目 + 对话框无限重取（v2 批次 / 稳定性）—— 2026-10-11

**本单元要修的那两件事**（互为因果，只有**打包态**才会同时中）：

1. **设置 → 关于 → 第三方许可证，在打包后的应用里永远列出 0 条**。
   根因：清单路径写的是 `join(process.cwd(), 'package.json')`；打包产物由 Finder 启动时
   `process.cwd()` 是 `/`，那里没有清单 ⇒ 读失败 ⇒ `return []`。
2. **空结果会让对话框无限重取**。effect 的守卫是 `entries.length > 0 || loading`，而依赖数组里
   **也含** `entries.length` 与 `loading` ⇒ 结果为空时 `setEntries([])` + `setLoading(false)`
   反过来又满足守卫，于是同一个打开的对话框把主进程的采集函数**每秒叫上千次**。

第 2 条只有第 1 条成立时才会被触发（结果非空时守卫自然成立），所以开发态（cwd = 仓库根、结果非空）
两种症状都看不见——它们是**只有用户那台打包版**才现形的形状。

## 一 真机读数（用户自己的日志，不是我造的夹具）

来源：本机 `~/Library/Logs/PureScience/main*.log`（应用自己写的主日志，只读）。
取数脚本**已入库可复跑**（本轮的读数就是它现算出来的，不是转录）：

```bash
node scripts/audit-third-party-licenses.mjs
# main.2.log: 371 warnings, 1 burst(s)
#   n=  371  start=2026-09-18T04:36:05.039Z  span=0.228s  rate=1627/s
```

| 读数 | 值 |
| --- | --- |
| 采集失败警告条数 | **371** |
| 突发数 | **1**（间隔全部 < 2 s） |
| 时间窗 | `2026-09-18T04:36:05.039Z` → `2026-09-18T04:36:05.267Z` |
| 跨度 | **0.228 s** ⇒ ≈ **1,627 次/秒**（一次打开对话框） |

## 二 独立期望 vs 实测（两套互相独立的取数）

**独立期望**由同一个入库脚本的 asar 侧给出（直接读安装包里 `app.asar` 的目录树与
`package.json` 正文，**不走应用自己的任何代码**）：

```bash
node scripts/audit-third-party-licenses.mjs          # 第二节即 asar 侧的独立期望
# direct dependencies declared in the packaged package.json: 23
# with package.json inside asar: 22
# with a LICENSE file inside asar: 20  <-- expected entry count
```

| 项 | 值 |
| --- | --- |
| 打包清单声明的直接依赖 | **23** |
| asar 内有 `node_modules/<名>/package.json` | **22**（缺 `@prisma/client`） |
| asar 内有 LICENSE 文件 | **20**（缺 `@bokuweb/zstd-wasm`、`js-tiktoken`） ⇒ **期望列出 20 条** |
| 安装包本体 | `app.asar` 264,994,191 字节，mtime `2026-10-10 20:14`（= 已发布 v1.102.0） |

**实测**由 Electron 真运行时跑（无窗口、单进程，`cwd = /` 复现 Finder 启动条件；
把安装包的 asar 作为锚点喂给应用自己的解析与采集函数）。探针是本轮会话的一次性脚本，配方如下
（它需要一份「用 `esbuild --bundle --platform=node --format=cjs --external:electron` 从
`src/main/third-party-licenses.ts` 现打的 CJS 副本」+ 一份 `initLogger` 桩）：

1. 打包锚点：`app.asar` 根 与 `app.asar/out/main`（模块目录）两个字符串；
2. 在 `require('electron')` 的进程里（`cwd` 设成 `/`）跑旧副本（`root = process.cwd()`）与新副本；
3. 打印各自的 `count` / 前四条名字 / 首条许可证首行 / 是否每条都有正文。

| 场景 | 读数 |
| --- | --- |
| 旧代码（root = `process.cwd()` = `/`） | **count 0** + 具名警告 `unable to read package.json…` ⇒ **复现打包态空清单** |
| 新代码，root = 已安装 `app.asar` | **count 20**，`allHaveLicense: true`，首条样文 `Apache License`，前四条 `@agentclientprotocol/claude-agent-acp@0.60.0` / `@agentclientprotocol/sdk@1.4.0` / `@anthropic-ai/tokenizer@0.0.4` / `@electron-toolkit/preload@3.0.2` |
| 新的根解析规则 | `resolveDependencyRoot(<asar>/out/main, <asar>)` → `{root: '…/app.asar', source: 'app-path'}`，结果同为 **20** |
| 旧代码的 cwd 模拟（root = 空目录） | **count 0** ⇒ 「空清单」不是数据问题、是取数位置问题 |

**20 = 20**：应用自己的新日志行与独立解析逐数吻合：

```
[third-party-licenses] third-party licenses collected {
  root: '/Applications/PureScience.app/Contents/Resources/app.asar',
  rootSource: 'explicit',
  dependencies: 23, listed: 20, missingPackageJson: 1, missingLicense: 2, unreadable: 0
}
```

（`missingPackageJson: 1` ↔ `@prisma/client`；`missingLicense: 2` ↔ `@bokuweb/zstd-wasm`、`js-tiktoken`。）

## 三 变异核对（证明守卫不是空壳）

把组件 effect 用 `git stash` 单文件回退到旧写法后重跑本单元新增的渲染用例：
**新用例当场红**（空态即死循环，跑到 60 s 超时）；恢复新写法后 4 passed。
即「一次打开只请求一次」这条断言确实在守第 2 条缺陷。

## 四 刻意的边界（不许读成「已做」）

1. **没有窗口截图读数**。本轮不开 Electron 窗口（内存闸门）；界面那一半的证据是
   渲染套件（4 条）+ 用户日志里的循环读数，**不冒充**窗口读数。
2. **`app.getAppPath()` 在真打包主进程里的返回值未直接取证**。探针是把打包锚点
   （asar 根 / asar 内模块目录）**显式喂给**应用自己的解析与采集函数；`getAppPath()` 本身
   的返回值属 Electron 平台行为，本探针没有直接证明。补取办法：下一次发版产物上开一次
   「关于 → 第三方许可证」，看是否列出 20 条。
3. **失败行的日志落盘读数只取到一半**：探针读回的 `collectorLogLines: []`（日志异步落盘未及读出），
   但同一批日志行**出现在探针的 stdout 里**（见 §二引文）⇒ 「失败行自证（路径 + 根 + 哪条规则）」
   有实跑样文，**「应用自己的日志文件里也落了这几行」这一条未取**（打包版运行时的落盘时机）。
4. 本改动是**运行时行为改动** ⇒ 占一个版本位，并入下一个版本边界；本单元**未打 tag、未抬号**。

## 五 收尾复核

见本轮会话汇报：端口无监听、临时目录已删、真实配置根未写入、`git status` 只剩并发写入者的在制品。

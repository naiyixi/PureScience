# Windows 分片红在一个 POSIX 夹具上：pipx 安装器的三条用例，以及查找表在 Windows 上一条可用路径都没有

- 时间：2026-11-24 24:0x（CST）
- 构建：`490f8fe1`（`Windows Full Test` run `45424389489`，分片 4/8 作业 `138552452900`）+ 本机隔离工作树
  `/tmp/ps-fix-pipx`（基于 `977d3f7c`）
- 归属：产生这段代码的是 Hermes 后端那几笔（`dab90419` / `64a65af2` 系列）；本档记录的是**夹具的可移植性缺陷**
  与查找表在产品侧的真实缺口，不是产品回归。

## 一 现取读数（作业级日志，不是车道结论）

`Windows Full Test` 分片 4/8：`Test Files 1 failed | 167 passed | 3 skipped (171)`，
`Tests 3 failed | 2432 passed | 26 skipped (2461)`。三条都在同一个文件里，逐字：

```
FAIL unit src/main/settings/hermes-install.test.ts > hermes pipx installer > streams pipx output while it runs and succeeds on exit 0
AssertionError: expected { installId: 'i2', ok: false, …(1) } to match object { ok: true, exitCode: +0 }

FAIL … > surfaces pipx own last lines when it exits non-zero, instead of a generic message
AssertionError: expected undefined to be 3 // Object.is equality

FAIL … > stops a hung pipx at the deadline and says it was stopped
AssertionError: expected undefined to be true // Object.is equality
```

同一批提交在 macOS/Linux 上绿：三条用例的夹具是 `writeFileSync(path, '#!/bin/sh\n…') + chmodSync(0o755)`，
再把这个文件当可执行文件 `spawn`。**Windows 不解析 shebang、也不认无扩展名的可执行文件** ⇒ spawn 以
`error`（EACCES/ENOENT）结束，`outcome.error` 有值、`code` 为 `null` ⇒ `ok:false`、`exitCode: undefined`、
`timedOut: undefined`。三条断言的形状与上面逐字一致。

## 二 本机复现（机制，而不是「大概是平台差异」）

把 `origin/main` 那份旧用例原样搬进隔离工作树，只把 `chmodSync(path, 0o755)` 去掉（＝让这个文件不可执行，
模拟「这条车道根本跑不起这份夹具」），三条用例在本机（macOS）以**同一批断言、同一批文案**转红：

```
FAIL … streams pipx output while it runs and succeeds on exit 0
AssertionError: expected { installId: 'i2', ok: false, …(1) } to match object { ok: true, exitCode: +0 }
FAIL … surfaces pipx own last lines when it exits non-zero, instead of a generic message
AssertionError: expected undefined to be 3 // Object.is equality
FAIL … stops a hung pipx at the deadline and says it was stopped
AssertionError: expected undefined to be true // Object.is equality
Test Files  1 failed (1)   Tests  3 failed | 2 passed (5)
```

⇒ 红的成因是**夹具假定了宿主会直接执行这个文件**，不是安装器逻辑。

## 三 修法

### 3.1 夹具：脚本化的子进程（同仓先例 `claude-install.test.ts`）

`hermes-install.ts` 新增可选 `spawnImpl`（生产缺省仍是 `node:child_process.spawn`，行为逐字不变）。
用例改为一个 `EventEmitter` 形状的脚本子进程，按需发出 stdout / stderr / `close(code)` / `error` / 永不关闭。

断言只增不减（旧版本没有的几条也补上了）：

| 断言 | 旧 | 新 |
| --- | --- | --- |
| 真的跑的是 `pipx install hermes-agent` | 间接 | 逐字钉 `command` 与 `args` |
| 调用方 env 透传 + `PIP_DISABLE_PIP_VERSION_CHECK=1` | 无 | 钉住 |
| 退出 0 ⇒ `ok:true`，stdout/stderr 各一路日志，恰好一次 `installing` 进度 | 有 | 有 |
| 退出 3 ⇒ `exitCode: 3` 且错误里带 pipx 自己的最后几行 | 有 | 有 |
| 挂住 ⇒ `timedOut:true` 且**真的 kill 了**（`SIGKILL`） | 只断言状态 | 加 `kill('SIGKILL')` |
| spawn 起不来 ⇒ `ok:false`、`exitCode:undefined`、错误是那条原文 | 无 | 新增（正是本次红的那条形状） |

### 3.2 产品侧：`pipx` 的查找表在 Windows 上一条可用路径都没有

`PIPX_CANDIDATES` 只有 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.pyenv/shims`。
在 Windows 上这四条都不存在 ⇒ `resolvePipxPath()` 恒 `null` ⇒ 用户点 Install 永远得到「pipx was not found」，
**即使他装过 pipx**。这与同目录 `hermes-detect.ts` 已有的 Windows 规则不一致（那边早就有 `%APPDATA%\Python\Scripts`
与 `%LOCALAPPDATA%\pipx\venvs\hermes-agent\Scripts`）。

修法：`pipxCandidates(deps)` 变成**平台/环境可注入的纯函数**，Windows 分支查

- `%APPDATA%\Python\Scripts`（`pip install --user pipx` 落点）、
- `%LOCALAPPDATA%\pipx\venvs\pipx\Scripts`（pipx 自己的脚本）；
- 名字按 PATHEXT 拼写试 `pipx.exe` / `pipx.cmd` / `pipx.bat` / `pipx`；

最后才是 PATH（按**该平台的分隔符**切：`path.win32.delimiter`），因为 GUI 应用继承的 PATH 常常不是 shell 的。
`resolvePipxPath(exists, deps)` 保留第一个参数（既有调用与用例不变）。

## 四 读数（本机现取）

| 项 | 读数 |
| --- | --- |
| 该文件 | `9 passed`（原 5 例 + 4 例；三条原用例断言只增不减） |
| `src/main/settings` 整目录 | `100 files passed / 1 skipped`；`1536 passed / 3 skipped` |
| `typecheck:node` / `typecheck:web`（隔离工作树，`--composite false`） | 0 / 0 |
| `eslint --no-cache` 两个改动文件 | 0 error（prettier 4 条 warning 已 `--write` 消掉） |
| 变异 ①：忽略注入的 spawn（生产路径） | `5 failed`，还原后 9 passed |
| 变异 ②：Windows 分支回落到 POSIX 规则 | `2 failed`，还原后 9 passed |
| 变异 ③：Windows 名字塌成裸 `pipx` | `2 failed`，还原后 9 passed |
| 旧夹具复现探针（去 exec 位） | `3 failed`，三条断言与 CI 逐字同形；探针文件跑完即删 |

## 五 边界（没证的）

1. **没有 Windows 真机读数**：本机是 macOS。判据是下一次 `Windows Full Test` 的分片里该文件出现
   `✓ src/main/settings/hermes-install.test.ts (9 tests)`，且分片整体 success。
2. Windows 上**装了真 pipx 时** Install 按钮是否真能装上，仍未被任何一条车道覆盖：查找表只证明「会去
   `%APPDATA%\Python\Scripts\pipx.exe` 这类位置找」，Windows 上的 P0 认证 spec 不点这个按钮。
3. `spawnImpl` 是测试缝：流式行为不再由「真子进程」证明，而由脚本子进程证明（与 `claude-install` 同一条口径）。
   真实 `pipx` 的 stdout 分块行为属 pipx 自己，本模块不解释它的格式。
4. 缺 pipx 时那句提示仍写着 `brew install pipx` / `python3 -m pip install --user pipx`（Windows 上 `python3`
   不是常用入口）；这是文案取舍，未改，留给会话那批文案一起收。

## 六 这一笔自己的第一趟 Windows 读数：第 9 例红在「把宿主的默认值当断言」

`aa8ee62b` 的 `Windows Full Test` 分片 4/8：`1 failed | 167 passed`，**三条旧红全绿**，唯一红的是我自己保留的
那条老用例：

```
FAIL unit src/main/settings/hermes-install.test.ts > hermes pipx lookup > returns the first candidate that exists, and null when none does
AssertionError: the given combination of arguments (null and string) is invalid for this assertion.
```

成因：`resolvePipxPath` 的 `deps` 缺省取**宿主平台**，而这条老用例的谓词写的是 `candidate.endsWith('homebrew/bin/pipx')`
—— 在 Windows 上候选全是反斜杠路径，谓词恒假 ⇒ 返回 `null` ⇒ `toContain` 拿 `null` 报上面那句。**修法不是放宽断言**，
而是把平台显式写进断言：`{ platform: 'darwin' | 'win32', homePath, env }` 三态各取一条，期望值用该平台自己的字面
路径并断言**全等**（顺带补一条「先命中者胜」的顺序断言）。教训与 `references/cross-platform-test-assertions.md`
同一条：**实现平台化之后，用例的默认值不再是常量** —— 任何依赖「宿主默认」的断言都要显式传平台。


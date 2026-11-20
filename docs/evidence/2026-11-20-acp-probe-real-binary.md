# 本机探针里 ACP 起了真实二进制：两种解释都不成立，判据是「持久化路径优先」

2026-11-20。被查对象是功能缺口路线图里那条「待查（未定因，不记为产品缺陷）」：某次本机探针把 python
选成一枚 `--copies` 裸 venv 之后再发 prompt，应用起来的是真实的 `opencode`（不是夹具的 shim），
`session/prompt` 以 `Cannot connect to API` 失败。原记载给了两种解释：①启用运行时这一步让应用重启、
夹具的 fake-agent PATH 丢失；②真实用户也会踩到。

**两种都不成立。** 真正的判据在解析顺序上：**已持久化的 `settings.opencodePath` 优先于 PATH 探测**，
而且第一分支根本不看 PATH。所以只要那个存储根里曾经写过一次真实路径，之后同一根里的任何启动
（哪怕 PATH 第一项就是夹具目录）都会继续用真实二进制。

## 一 读数（逐字，来自该次探针的应用进程日志）

日志 `test-results/app-process/002-certification-zz-probe-spec-ts-probe-selected-bare-venv-runs.log`
（**本地证据，test-results 会被清理；下面的原文已抄在这里，不依赖该文件仍在盘上**）：

```
[settings:backend] framework selection { forced: 'opencode', stored: 'opencode', resolved: 'opencode' }   ← L46
[acp] agent backend resolved { framework: 'opencode', generation: 1, status: 'connecting' }               ← L340
[acp] agent spawn {
  framework: 'opencode',
  executablePath: '/opt/homebrew/bin/opencode',        ← 真实二进制
  args: [ '--port', '64547', '--hostname', '127.0.0.1' ],
  pid: 23993,
  pathEntryCount: 39                                   ← PATH 有 39 项（没有被截断成空）
  （原文还有一行 cwd，是与本题无关的仓库路径，已略）
}
...
[acp] prompt failed {
  error: 'Internal error: Cannot connect to API: Unable to connect. Is the computer able to access the url?'
```

三条各自有用：

1. `forced: 'opencode'` ⇒ 夹具的框架强制**生效了**（该环境变量只在不带夹具的分支之外由夹具注入），
   所以「夹具根本没接上」这种可能被排除。
2. `pathEntryCount: 39` ⇒ 传给子进程的 PATH 是完整的、非空的一份。
3. 同一轮探针的 provider 是 `http://127.0.0.1:9/v1`（E2E 用的假端点，无人监听）。**真实** opencode
   当然连不上它 ⇒ `Cannot connect to API` 是「用错二进制」的后果，不是独立的第二个缺陷。

## 二 为什么真实二进制会赢：解析顺序（`file:line`）

- `src/main/settings/backend-resolver.ts:727` —— opencode 框架走
  `await this.runtime.resolveOpencodeExecutable(settings.opencodePath)`，**把持久化值作为入参**。
- `src/main/settings/agent-runtime-manager.ts:921-930` ——

  ```ts
  async resolveOpencodeExecutable(storedPath: string | undefined): Promise<string> {
    if (storedPath && (await this.pathExists(storedPath))) return storedPath   // ← 第一分支就返回，不看 PATH
    const detected = await detectOpencode(this.opencodeDetectDeps)
    ...
  }
  ```

- `src/main/settings/opencode-detect.ts:59-71` —— 只有在**没有**可用持久化值时才走探测；探测内部
  `pathDirs` 排在数组最前面（`...pathDirs, ~/.local/bin, ~/.opencode/bin, extraDirs, wellKnownDirs, npmBinDirs`），
  也就是说 PATH 里第一个能跑 `--version` 的目录胜出。夹具把 fake bin 放在 PATH 第一项，这一层本来是赢的
  —— 前提是**它真的被走到**。

所以「夹具 PATH 有没有」在这里不是决定性的量；决定性的量是 `settings.opencodePath` 此刻的值。

## 三 解释①（启用运行时导致重启 ⇒ PATH 丢失）在代码上不成立

- `app.relaunch()` 全仓只有一处：`src/main/storage/command-owner.ts:457`（数据根迁移）。
  更新链路走 `quitAndInstall`，与笔记本运行时无关。`src/main/notebook/**` 里没有任何重启应用的分支
  （只有错误文案里出现 "relaunch" 这个词）。
- 即便真的重启，环境变量是从父进程继承的（夹具是在 `electron.launch({ env })` 里注入 PATH 的），
  重启不会让 PATH 丢掉夹具目录 —— 这条推论与「重启是否存在」独立。

## 四 解释②（真实用户也会踩到）不成立

真实用户能走到走「持久化值为真实路径」这一步，正是因为他们装的**就是**真实二进制；这是设计上的优先序
（用户指过/装过的路径必须压过 PATH 探测，否则自定义安装位置会被系统里另一个同名二进制抢走）。
本机探针是「同一个存储根里既有带夹具的启动、也有不带夹具的启动」，于是真实路径先被写进去，
后面夹具那一次就再也赢不回来 —— 这是**夹具场景的假阴性**，不是产品缺陷。

## 五 仍未取证的一格（下一轮只需读两个值）

**谁**在那个存储根里写入了 `/opt/homebrew/bin/opencode`，没有取到证：那次探针的隔离根
（`purescience-electron-e2e-*`）已被清理，`settings.json` 不在盘上。这一格不影响上面的判据
（解析顺序与日志是自证的），但要结案成「夹具该怎么写」需要它。

下一轮的取法（各一条读数，别猜）：

1. 夹具启动后读 `<隔离根>/storage/settings.json` 的 `opencodePath` —— 是夹具路径还是真实路径；
2. 在同一份应用日志里读 `[acp] agent spawn` 的 `executablePath` 与 `pathEntryCount`。

若第 1 项已经是真实路径，则结案为「同根复用导致」；若第 1 项是夹具路径而 spawn 仍是真实路径，
那才是产品侧的新问题（此时才立项）。

## 六 不修的东西

- **不改产品代码**：优先持久化路径是对的（见 §四），为一条本机夹具假阴性去改解析优先序，等于让真实用户
  的自定义安装路径被系统性忽略。
- **不写进 CHANGELOG**：这一条从未构成对外能力主张。
- 夹具侧若要更稳，属于测试台改进（例如在启动后显式把 `opencodePath` 写成夹具路径，或在启动前清掉该字段），
  与本条「定因」分开立项。

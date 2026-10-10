# P0-6（前半）：项目范围围栏的三类误伤（2026-10-11）

> 一句话：这道围栏在**把不是路径的东西当成路径**——命令分隔符粘在路径上、awk/sed 的正则程序、
> 以及模型权重缓存目录。前两类是**分词器缺陷**（把本该放行的拒了，其中一条把应用**自己的根目录**
> 拒了，只因 token 尾巴上多了一个分号），第三类是**政策面**（拒了它没有任何保护收益）。
> 真机读数：用户自己机器上的围栏决策日志 **662 行 / 36 条拒绝**，逐条分类见 §二。

## 一 缺口核实（对源，不靠计划里的措辞）

计划里 P0-6 的修法写的是「**数据根自身与权重缓存进白名单**；工具注册名两侧一致」。对源之后，这两句
各自要改一处说法：

1. **数据根并没有被排除在白名单外。** roots 由 `agent-runtime-manager.ts:727` 传入
   （`{ roots: [dataRoot, this.storageRoot], hint: dataRoot }`），本机打包版实际写出的 roots 文件内容是
   `{"roots": ["/Users/totota/.purescience"], "hint": "/Users/totota/.purescience"}` ——
   根就在白名单里，且 roots 与 config 根在本机是同一个目录。
   真机日志里那条"数据根被拒"的原文是：

   ```json
   {"tool":"Bash","target":"/Users/totota/.purescience;","resolved":"/Users/totota/.purescience;","decision":"deny"}
   ```

   ⇒ 真因是**分词器把 `;` 留在了 token 里**：`/…/.purescience;` 既不是根、也没有比它更深的已存在祖先，
   于是按"范围之外"拒绝。**按「加白名单」去修是对着症状修**——机制修法在分词。
2. **工具注册名那半不在本单元**（它是 agent 面向身份的改名连锁，见 §六 立案），本单元不碰。

## 二 真机读数（用户自己的打包版围栏日志，不是压测）

来源：`~/.purescience/claude/hooks/path-guard-decisions.jsonl`（mtime **2026-10-10 21:47**，**662 行**）。

| 拒绝类别 | 条数 | 说明 |
| --- | --- | --- |
| 根 / 家目录本身 | 16 | 含 `/`（**刻意保留**）、`/tmp`（刻意保留）、`~`、`/Users/totota` |
| 正则或通配 token | 6 | `/^`、`/^def`、`/^ATOM/{print}`、`/^ATOM\|^HETATM/{print}`、`/Users.*esm2.*`、`/Users/totota/*ProteinMPNN*` |
| 模型权重缓存 | 6 | `~/.cache/torch/hub/checkpoints[/]`、`~/.cache/huggingface[/hub]` |
| 其它 | 3 | `/tmp/v1_backup.py`、`~/.ssh/`、`~/.ssh/config` |
| agent 自己的临时件 | 2 | `/private/tmp/claude-501/…/tasks/*.output`（读自己的后台任务输出） |
| 标点粘连 | 2 | `/Users/totota/.purescience;`（**本单元的主症**） |
| 工具链二进制 | 1 | `/Users/totota/.local/bin/python` |

三处原文命令（从会话转写里逐字取到，不是复原的）：

- `cd /Users/totota/.purescience; echo "=== project tree (depth 2) ==="; ls -la; …`
- `du -sh ~/.cache/torch/hub/checkpoints/ 2>/dev/null; ls -la ~/.cache/torch/hub/checkpoints/ 2>/dev/null`
- `find / -maxdepth 6 -iname "*LigandMPNN*" -o -iname "*ProteinMPNN*"`（这条**该拒**，`/` 是整盘搜索）

## 三 交付（`src/main/settings/path-guard-hook.ts` + 其用例）

| 面 | 改法 |
| --- | --- |
| 分词 | token 现在按**空白与 shell 分隔符**（`; \| & ( ) < >`）切开，并去掉粘在尾巴上的 `,`；只判位置，不判标点。切分只会**增加**被判的 token，所以这是收紧而不是放宽 |
| 正则程序 | 新增 `looksLikePattern()`：**首段**以 `(`、`^`、`{`、`\|`、`+` 之一开头 ⇒ 是模式、不是位置；Windows 盘符/UNC 路径显式排除 |
| 权重缓存 | 新增 `RUNTIME_CACHE_PREFIXES`（`~/.cache/torch/hub/checkpoints`、`~/.cache/huggingface`）与 `underRuntimeCache()`，在系统前缀之后放行 |
| 文件工具同一类 | `targets()` 里 `pattern` 字段同样过 `looksLikePattern`（Grep 的 `/^ATOM/` 以前也会被判成位置） |

## 四 提权论证（放宽之前先写成可复查的，三条）

1. **调用者已经有更强的权力。** 这道 hook 只判**工具输入里写出来的**路径（脚本里算出来的路径本就在它
   的射程之外，见该文件模块注释）。也就是说：agent 早就能用一行 Python 把同一个缓存目录读出来，
   放行"把路径写出来"这种写法**不构成新的能力**，只是把误伤拿走。
2. **被放宽的表面没有暴露任何项目数据或凭据。** 两个条目都是框架下载的**模型权重**（torch / transformers
   的 hub 缓存），不含用户项目内容、不含凭据；真正该保护的东西（其它项目的树、`~/.ssh`、`/etc/passwd`、
   整盘搜索）在 §五 的负向对照里**仍然逐条被拒**。
3. **名单是字面命名空间，fail-closed 规则写死。** 条目是**具名**的两个目录（不是 `~/.cache/**`），
   比较走与系统前缀同一条 `normalize()`+`path.sep` 逻辑（同一条或在其下才算）；**Windows 的拼写故意不列**
   —— 那个平台没有读数说明这些框架把权重放哪，猜一个就等于让围栏看起来比实际更宽。

## 五 前后对照读数（同一批真 payload，两个真 node 进程，exit 0）

- **before** = 用户机器上**正在跑的那份产物** `~/.purescience/claude/hooks/path-guard.cjs`
  （仅把它内嵌的两个路径改到隔离目录，其余字节不动）。
- **after** = 本仓 `writePathGuard()` **现在写出来的**那份（由应用自己的 writer 生成，不是手抄）。

| payload（真机原文） | before | after |
| --- | --- | --- |
| `cd /Users/totota/.purescience; …; ls -la` | **deny** | **allow** |
| `du -sh ~/.cache/torch/hub/checkpoints/ …` | **deny** | **allow** |
| `awk '/^ATOM\|^HETATM/{print}' receptor.pdb > clean.pdb` | **deny** | **allow** |
| `Read ~/.cache/huggingface/hub/models--x/config.json` | **deny** | **allow** |
| `cat /Users/totota/.ssh/id_rsa` | deny | deny |
| `find / -iname "egfr_t790m_merged.csv"` | deny | deny |
| `ls -la /Users/totota/*ProteinMPNN*` | deny | deny |
| `Read ~/.cache/other-tool/data.csv`（同父目录的兄弟缓存） | deny | deny |
| `ls /tmp`（临时目录刻意不在 roots） | deny | deny |

before 的决策日志里那条中标点粘连的记录是
`{"tool":"Bash","target":"/Users/totota/.purescience;","resolved":"/Users/totota/.purescience;","decision":"deny"}` ——
与 §二 引用的**用户机器上那条记录逐字符相同**，即探针复现的不是"类似形状"，是同一条。

## 六 刻意的边界（不许读成"已做"）

1. **agent 自己的临时件仍被拒**：`/private/tmp/claude-501/…/tasks/*.output`（它读自己的后台任务输出）。
   临时目录不在 roots 是**刻意的设计**（放行会打开所有其它进程的 scratch），而这条 read 是"harness 把
   自己的产物递给自己"的正当用法 ⇒ 属**产品决策项**，本单元不动，具名留档。
2. **`~/.local/bin/python` 这类工具链二进制仍被拒**（1 次）。系统前缀表管的是"命令跑起来必须有"的目录，
   用户的 `~/.local/bin` 是不是该进去，是同一类决策项，本单元不动。
3. **首段没有正则元字符的模式仍会被当路径**（真机 6 条里没有这种形状；例：`sed -n '/def p/{p}'` 含空格会被
   切成两个 token）。这是本单元**刻意收窄**的代价：宁可少修一例，也不让通配逃出围栏（`/Users/<user>/*MPNN*`
   必须继续被拒）。
4. **变量拼写本来就不判**：`$HOME/.ssh/id_rsa` 这种 token 在改动前也不进判定（`looksLikePath()` 不认），
   本单元没有改变这一点，也没有新增口子。
5. **Windows 的权重缓存拼写未列**（见 §四.3）。
6. **本单元没有 Electron 窗口读数**：改的是 hook 的生成源与判定，读数是"真 payload + 真 node 进程 +
   应用自己的 writer 产物"；窗口内驱动一次真会话属 §七 立案，不假装有。
7. **P0-6 的后半（工具注册名两侧一致）立案，不在本单元**：本机日志显示同一个"工具不存在"
   （`No such tool available`）累计 **25 次**，两种拼写都有人猜错——`mcp__purescience-plan__generate_plan`
   （连字符）**是真存在的工具**（那次失败是入参 JSON 解析失败，证明工具在），而
   `mcp__purescience_plan__update_step_status`（下划线）**报 No such tool available**；反向也发生过
   （`mcp__purescience-notebook__…` 报不存在，而 notebook 服务名本来就是下划线）。
   即：**同一个应用里两套命名约定并存**（`purescience_notebook` 下划线，`purescience-plan/-figure/-artifacts/
   -activity/-skills` 连字符），模型只能靠猜。改法就是该文件自己注释里写的方向（连字符清零，`legacyNames`
   兜旧拼写），**计数：`src` + `e2e` 里这 5 个名字共 164 行 / 44 个文件**（另有 96 行 `mcp__purescience_*`
   的转义形态）⇒ 属改名连锁 + agent 面向身份变更，**单独立项**，不掺进本单元。

## 七 下一轮

1. 本单元提交后按具名 run id 取两条车道判决（`cancelled` 不算绿）。
2. P0 批剩 **P0-9**（权限询问 2,128 次 / 68 会话）、**P0-10**（内容存储 14.28 GB / 290,495 文件）、
   以及本档 §六.7 的**工具注册名一致**（已成条，带计数）。
3. 跨轮不变：IC40 needs-attention、IC6 收割、中文源四家、M2/IC54（产品决定）。

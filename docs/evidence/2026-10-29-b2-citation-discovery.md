# B2 引文发现：真机读数（两个方向 / 中英两侧 / 三条中文判据的实测分布）

> 日期 2026-10-29（CST 06:2x–06:5x）。提交面 `97a105fd`（实现）+ `f0d3bd45`（中文前缀表按真机命中补齐）。
> 本档的数字**全部由本轮自己重跑取得**（不是引用上一轮记录）。

## 0 一句话

计划档的验收是「同查询中英各有命中，每条附理由段」。本轮在真实 OpenAlex 上跑了四个方向、六个记录：
**英文记录的 50 条引文、中文出版方记录的 47–50 条引文都能拿到，且每一行都带判据（`title-han` / `doi-prefix`）**；
`language:zh` 这个字段在 200 行样本里只命中 2 行 —— 把它当判据会漏掉 194 行，这正是本轮不用它的理由。

## 1 探针怎么跑的（不是单测替身）

临时探针文件直接 import 产品模块 `src/main/references/citation-discovery.ts` 的 `discoverCitations`，
`fetchImpl` 注入真实 `fetch`，无 key、无代理、公开 API（`api.openalex.org`）。
读到的每一条都经过模块自己的限量、三态与信号计算 —— 也就是**主进程真实走的那段代码**，取完即删（不入库）。

## 2 四个方向的读数

| 记录 | 方向 | status | total（源自述） | examined（真读） | chinese | incomplete |
| --- | --- | --- | --- | --- | --- | --- |
| `10.1038/nature14539`（LeCun 2015，英文） | references | `found` | 53 | **49** | 0 | **true**（`this work lists 53 references; the walk reads the first 50`）|
| 同上 | citations | `found` | **83,700** | 50 | 0 | false |
| `10.53388/ccmr2022022`（TMR，中文出版方） | citations | `found` | 113 | 50 | **49** | false |
| `10.53388/ccmr2021015` | citations | `found` | 89 | 50 | **50** | false |
| `10.26549/yzlcyxzz.v4i3.6890`（协和医学） | citations | `found` | 116 | 50 | **50** | false |
| 同上 | references | `found` | 7 | 7 | 0 | false |
| `10.26549/yzlcyxzz.v3i4.3108` | citations | `found` | 163 | 50 | **47** | false |
| 同上 | references | `empty` | 0 | 0 | 0 | false |
| `10.12677/pm.2014.44021`（汉斯） | references | `empty` | 0 | 0 | 0 | false |
| `10.12677/japc.2015.44013`（汉斯） | references | `found` | 32 | 32 | 0 | false |
| `10.12677/japc.2015.44013` | citations | `found` | 249 | 50 | 0 | false |
| `10.1001/jama.1968.03140320031009` | references | `empty` | 0 | 0 | 0 | false |

**四条读法（都不许读成更强）**

1. **英文侧命中**：`citations` 方向 83,700 条里只读 50 条 ⇒ 结果里 `examined=50`、`total=83700`，界面那句
   「读了前 N 条」是这句话的上屏形态，不是「全部」。
2. **中文侧命中**：四个中文出版方记录的 `citations` 方向分别 47/49/50/50 —— 与计划档「中英各有命中」对齐。
3. **`references` 方向在中文刊上多为空**：三条 `empty`、一条 7 条英文、一条 32 条全英文。这是**源的事实**
   （OpenAlex 没有给这些记录建参考文献表），模块如实报 `empty`（=「源回答了，没有」）而不是 `unavailable`。
4. **限量是硬上限**：`10.1038/nature14539` 的 53 条参考文献只读 49 条就撞上 2 页上限 ⇒ `incomplete=true` 且
   `error` 里写清「53 条只读前 50」。**这一格是本轮唯一出现 partial 的地方**，界面据此打「Partial read」。

## 3 三条中文判据的实测分布（200 行）

把上面四个中文出版方记录的 `citations` 结果（各 50 行，合计 **200 行**）逐行按信号统计（同一条探针第二次跑）：

| 判据 | 命中行数 |
| --- | --- |
| `doi-prefix`（出版方在中国） | **194** |
| `title-han`（标题汉字占比过线） | **2** |
| `journal-language`（期刊语种） | **0** |
| 三条皆无 | 4 |

交叉核对（同一批 200 行）：

- `language === 'zh'` 的行只有 **2 行**，且这 2 行都被 `title-han` 抓到（**漏 0 行**）；
- 反过来，**194 行带着中文源信号、而源把它们标成 `en`** ⇒ 用 `language:zh` 当判据会把这 194 行全部漏掉。

⇒ 结论与模块头注一致：**干活的是 DOI 前缀，「期刊语种」现实中几乎不触发（`source.language` 为 null）**；
而「出版方在中国」不等于「正文是中文」（汉斯出英文刊），所以行上的理由句只声称前者 —— 与本轮 194 行里
大量英文标题的汉斯条目相符，不放大。

## 4 三态与拒答（同一轮读到的）

| 输入 | 结果 |
| --- | --- |
| 未知方向 | `unavailable` + `unknown direction` |
| 记录无 DOI（或 DOI 形状不合 `^10\.\d{4,9}/\S+$`） | `unavailable` + 具名原因，**一个请求都不发** |
| 源回答了但集合为空 | `empty`（不是 `unavailable`） |
| 源读不到 | `unavailable` + `error`（本轮由单测覆盖，未构造真实断网读数） |

## 5 边界（不许读成更强）

1. **本轮没有活实例（窗口/IPC）读数**：探针走的是主进程模块本体，`references:discover-citations` 的通道外壳
   与渲染层那一段由 `screening-ipc.test.ts` / `ReferencesLibraryDialog.render.test.tsx` 覆盖。
   活实例读数未取的原因具名：本机空闲物理页 ~4.3k（≈68 MB）、swap 11.4/12.3 GB 已用，且用户常驻 dev 实例
   正在占用 `out/`；再起一个隔离实例属于「会抢在跑实例资源」的动作，留给内存宽松的窗口。
2. **`total` 是源自述**，`examined` 才是真读到的行数；两者相差两个数量级时（83,700 vs 50）界面必须同时给。
3. **汉斯（`10.12677`）是英文刊**：它的行拿到 `doi-prefix` 只说明「出版方在中国」，理由句逐字如此，不声称语言。
4. **本轮不声称「中文文献覆盖完整」**：中文侧的参考文献方向在样本里基本为空，这是源侧的缺口，不是本功能的判决。

## 6 复跑配方（1 分钟量级）

1. 在 `src/main/references/` 下建一个临时 `.test.ts`，`import { discoverCitations }`，注入
   `fetchImpl = (url, init) => fetch(url, init)`；
2. 对 `10.1038/nature14539`（英文）与 `10.53388/ccmr2022022` / `10.26549/yzlcyxzz.v4i3.6890`（中文出版方）
   各跑 `references` 与 `citations`；
3. `npx vitest run <该文件> --reporter=verbose`，读 `status/total/examined/chineseCount/incomplete` 与逐行 `signals`；
4. 取完即删该文件（**探针不入库**），读数抄进本档。

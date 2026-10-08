# 中文术语单一来源表 + PubMed 中文查询走它（2026-10-08）

批次 ①（中文医学场景）第一个单元。被测提交 **`f2dac485`**，门禁在**隔离工作树**上跑（同树另有
自主执行器在编 `zh-medical-terms` 连接器 ⇒ 它的在制品不进本读数）。

## 一、前提：真机读数，不是推断

直连 `esearch.fcgi`（2026-10-08，本机）：

| term | 读数 |
| --- | --- |
| `aspirin` | HTTP 200，`count=1` |
| `阿司匹林` | HTTP 200，**`count=0`**，`warninglist.outputmessages=["No items found."]` |

⇒ 中文提问过去拿到的 0 **不是**"没有证据"，是"从未查过"。把它读成阴性就是拿一次没发生过的检索
当结论——这正是本单元要堵的形状。

## 二、交付物

| 落点 | 内容 |
| --- | --- |
| `src/shared/chinese-terms.ts`（新） | 单一来源表 + `normaliseTerm()` + `planChineseQuery()` |
| `src/shared/chinese-terms.test.ts`（新） | 读源测试（钉表与导出）+ 归一化行为测试，19 用例 |
| `src/main/connectors/descriptors/pubmed.ts` | `search_articles` 接线中文查询 |
| `src/main/connectors/descriptors/pubmed.test.ts` | 中文路径 4 用例（含"拒绝时一个请求都不发"） |

**表规模（读源实测）**：**217 条词条 / 285 个键** —— 药名 87、适应证 87、机构名 15、期刊名 17、
中文虚词 11。同义异名收在**同一行的 `variants`**，不另开一行。

**可核对性**：`normaliseTerm('阿司匹林')` 返回 `substitutions: []`（本来就是规范写法），
`normaliseTerm('扑热息痛')` 返回 `substitutions: [{from:'扑热息痛', to:'对乙酰氨基酚'}]` ——
「什么都没替换」与「表里没有」（`unknown-term`，具名）可区分。`planChineseQuery()` 额外返回
**真正要发出去的字符串**与 `unmapped`（表里没有的中文串，逐词点名）。

**CJK 检测复用** `src/shared/citation/names.ts` 的 `hasCjkScript()`，不另造第二份脚本判定。

## 三、接线后的真机读数（走真正接线的工具打真 PubMed）

一次性探针（跑完即删）经 `ParserEngine` 调 `search_articles`：

| 查询 | total_count | `zh_terms.query_sent` | 备注 |
| --- | --- | --- | --- |
| `阿司匹林` | **80708** | `aspirin` | PubMed 自己把它映射到 `"aspirin"[MeSH Terms]` |
| `阿司匹林治疗高血压` | **4910** | `aspirin hypertension` | `removed: ['治疗']` |
| `阿司匹林用于晚期肺癌` | — | — | **具名拒答**，点名 `晚期`，并列出已映射的 `阿司匹林→aspirin、肺癌→lung cancer`；**一个请求都没发** |

## 四、门禁（隔离工作树 `/tmp/zh-gate`，被测提交 `f2dac485`）

| 环 | 读数 |
| --- | --- |
| `vitest run src/main/connectors src/shared --maxWorkers=4` | **189 文件通过 ｜ 2093 passed ｜ 50 skipped（2143）**，exit 0 |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0**，零输出 |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0**，零输出 |
| `npx eslint --no-cache .`（全仓） | **0 error ／ 128 warning**（= 本仓既有基线；我触碰的 4 个文件 0 problem） |
| 提交信息 / 品牌扫描 | `✓ 提交信息零命中` |

**双 typecheck 抓到 vitest 抓不到的两处**（vitest 只转译不检查类型）：`TermSubstitution.entry`
的类型写窄了一个变体、以及由此在消费点产生的两处 `TS2367`。已当批修；`tsc` 是这两条唯一的守卫。

## 五、边界与未做（具名）

1. **中文源连接器仍挂账**：`chictr.org.cn` / `nmpa.gov.cn` / `cde.org.cn` / `chinadrugtrials` 四家
   经实测全是 HTML/SPA/WAF（405/302/202+HTML），无可用机读契约。**不写只读抓取器**——服务方 HTML
   不是稳定契约。等有文档的接口再启。
2. **「发布机构 + 年份 + 原文出处」那一半不在本单元**：本单元只保证**问得出去**（中文术语能落到
   PubMed 的检索面上并如实回报做了什么）。出处一侧由同批的 `zh-medical-terms` 连接器（Wikidata
   跨语言索引，自主执行器在建）承接；两者**共用同一张表**——那个连接器刻意不带词表，把
   「应用已知的词」留给共享层，避免长出第二套词汇。
3. **表是人工维护的**：217 条之外的中文术语会**具名拒答**（点名那个词），不会静默丢弃、
   不会退化成"返回 0 条"。表要继续长，就往 `CHINESE_TERMS` 里加行——读源测试会钉住它的下限。
4. 本单元**未改**：无新通道、无新 i18n 键、无契约计数涟漪（未增删连接器/工具）；无中文的查询走
   原路径，返回形状与之前逐字段一致。

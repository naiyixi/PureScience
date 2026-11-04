# Zenodo / arXiv 的 DOI 现在能被加进文献库 —— 2026-11-05

## 一 缺口：一条到处都能打开的 DOI，产品说「查不到」

排期 v2.26.0 的「arXiv/Zenodo 可引用」一项。实测把两半分开看（2026-11-05，真网络，逐条 curl）：

| 端点 | `10.5281/zenodo.8300489`（Zenodo 数据集） | `10.48550/arXiv.1706.03762`（arXiv 预印本） |
| --- | --- | --- |
| `api.openalex.org/works?filter=doi:…` | 200，`meta.count = 0`，`results = []` | 200，`meta.count = 1` |
| `api.crossref.org/works/…` | **404** `Resource not found.` | **404** `Resource not found.` |
| `doi.org/doiRA/…` | 200，`RA: "DataCite"` | 200，`RA: "DataCite"` |
| `api.datacite.org/dois/…` | 200，9,628 字节（标题 `DECIMER V2 Models`、出版方 Zenodo、2023） | 200，16,000 字节（`Attention Is All You Need`、2017、`resourceTypeGeneral: Preprint`） |

⇒ 两半的真实状态不一样：**arXiv DOI 那一半早已可用**（OpenAlex 索引了它），真正缺的是 **DataCite 那一半**——
数据集 / 软件 / 数据期刊的 DOI 在索引里是 0 命中，产品据此返回「未找到」，而记录就在隔壁的登记机构里。
完整性检查（撤回 / 更正）则两半都答不出来：Crossref 对它们一律 404。

## 二 改法（七个文件，各只动自己那一处）

| 位置 | 改动 |
| --- | --- |
| `src/main/references/service.ts` | DOI 分支：索引没有命中（或索引本身非 2xx）时，再问一次 `api.datacite.org/dois/<doi>`；命中则按同一份 `CreateReferenceInput` 填标题/作者/出版方/年份/类型/摘要/出处快照。DOI 先归一（去掉 `https://doi.org/` 前缀）。**没有标题的记录不算命中**（否则会造一条空标题、引用键凭空生成的记录）。作者：`givenName`/`familyName` 都有时拼成「名 姓」（引用样式直接可印），否则沿用记录自己的 `name`（`"Habenicht, Hannah"` 这种倒序串**不猜**姓在哪里结束）。 |
| `src/main/references/doi-integrity.ts` | Crossref 非 2xx 且状态是 **404** 时，问一次 `doi.org/doiRA/`：登记机构不是 Crossref 就把机构名写进 `error`（`— the DOI is registered with DataCite, and this check reads Crossref notices only`）。问不到就保留原句 —— 不把「不知道」写成「Crossref」。 |
| `src/shared/references.ts` | `ReferenceSourceConnector` 增加 `datacite`：记录的出处必须说得出是哪个登记机构，不能冒充那个只覆盖期刊论文的索引。 |
| `src/main/session-package/import-evidence.ts` | 会话包导入的白名单跟着加 `datacite`（否则从会话包带回来的这类记录会被降级成 `manual`）。 |
| `src/shared/egress.ts` | 文献域组的域名表加 `datacite.org`：开了出网闸门的笔记本里，脚本也够得着这个登记机构（同组的 `doi.org`/`crossref.org` 早就在）。 |
| 三份测试 | `service.test.ts` 三项（回退命中 / 两个登记机构都没有 → `null` / 无标题不算命中）、`doi-integrity.test.ts` 一项（404 时报出登记机构，机构查询失败时保留原句）、`egress.test.ts` 一行（文献组含 `datacite.org`）。 |

## 三 真读数（产品自己的函数、真网络、真记录）

`VITEST_LOCAL=1 npx vitest run src/main/references/datacite-registry.local.test.ts`（本笔新增，默认跳过）：

```
ZENODO           {"title":"DECIMER V2 Models","venue":"Zenodo","year":2023,"connector":"datacite",
                  "sourceUrl":"https://api.datacite.org/dois/10.5281%2Fzenodo.8300489","snapshotChars":9608}
ARXIV            {"title":"Attention Is All You Need","venue":"arXiv (Cornell University)","year":2017,
                  "itemType":"preprint","connector":"openalex"}
INTEGRITY-DATACITE {"status":"unavailable","sourceUrl":"https://api.crossref.org/works/10.5281%2Fzenodo.8300489",
                  "error":"Crossref answered HTTP 404 — the DOI is registered with DataCite, and this check
                  reads Crossref notices only"}
INTEGRITY-CROSSREF {"doi":"10.1038/nature14539","status":"clean","sourceUrl":"https://api.crossref.org/works/10.1038%2Fnature14539"}
5 passed
```

- **第一行是本笔的分量**：一条真数据集 DOI 走产品路径（OpenAlex → 未命中 → DataCite）拿到了标题、出版方、年份与
  9,608 字符的出处快照。
- **第二行是「查过才知道」的那一条**：arXiv DOI 本来就通，且第一次答话的是索引（`connector: openalex`）——
  若照「两半都缺」去写，会把已经可用的那一半也算成欠账。
- **第三行是拒答而不是担保**：DataCite 没有撤回语义，所以判决仍是 `unavailable`，但读者看到的是一句能行动的话
  （去哪个登记机构了），而不是「这个 DOI 可能有错」。
- **第四行是对照**：Crossref DOI 仍走原路、仍判 `clean`，回退没有把主路改坏。

## 四 门禁读数（隔离工作树 `/tmp/ps-doi` @ `9388544e` + 本笔）

| 环 | 读数 |
| --- | --- |
| 定向 vitest（references + session-package + cases） | **48 files / 521 passed / 1 skipped** |
| 全量 vitest `--maxWorkers=4` | **1459 files passed \| 31 skipped（1490）**；**18,265 passed \| 227 skipped（18,492）**；**exit 0**（281.1 s） |
| `tsc --noEmit -p tsconfig.node.json --composite false` | **exit 0**（默认堆会 `Reached heap limit`，按仓规带 `NODE_OPTIONS=--max-old-space-size=8192`） |
| `tsc --noEmit -p tsconfig.web.json --composite false` | **exit 0** |
| `npx eslint --no-cache`（本笔 9 个文件） | **exit 0 / 0 problem** |
| 变异自证（两处各一次） | ① 把 DataCite 回退改回 `return null` ⇒ `service.test.ts` **1 failed / 19 passed**（正是那条回退用例），改回即 70 例全绿；② 把机构名那句拼句改成空串 ⇒ `doi-integrity.test.ts` **1 failed / 16 passed**，改回即绿 |

## 五 边界（不许读成更强）

1. **完整性检查仍不判 DataCite 的撤回**：DataCite 的关系词表里没有撤回谓词，这类 DOI 的判决仍是 `unavailable`，
   绝不写成 `clean` —— 「查不到撤回」不等于「没有撤回」。本笔只让它**说清自己查的是哪一家**。
2. **没有真窗口读数**：本笔到主进程通道为止（真网络 + 产品函数）。界面上「按 DOI 添加」走同一条
   `references:fetch-by-identifier`，但**没有**在 Electron 窗口里点一遍。原因见 `docs/plan-…` 的收尾节（资源闸门），
   不冒充「实机通过」。
3. **只认 DataCite 资源类型里与本仓引用词表对得上的那几种**（Dataset / Preprint / JournalArticle /
   ConferencePaper / Book / BookChapter / Dissertation / Report）；Software、Image、Model 一类没有对应词表，
   按「没有类型」处理（引用样式自己回落），不硬塞成「数据集」。

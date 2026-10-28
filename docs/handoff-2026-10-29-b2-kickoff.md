# 交接单：B2 引文发现（2026-10-29 立项）

> 用法：把本文件整段粘给新会话即可开工。数字都是本机实测，不是估计。

## 0 一句话现状

B1（引文完整性）与 B3（阅读状态）已发布式收口并推送；C1（框架==二进制）守护已落地。**v2.20.0 只差 B2 一项**。

| 项                                                 | 状态                     | 提交                         |
| -------------------------------------------------- | ------------------------ | ---------------------------- |
| B1 完整性：六组接线 + 四路信号 + 证据落库 + 真入口 | 完成（真机读数在证据档） | `91a9879c` + 证据 `19f7b02d` |
| B3 阅读状态：三态 + 过滤 + 点名                    | 完成（真机读数在证据档） | `83c9c04e`                   |
| C1 框架==二进制：CI 映射断言 + 真机四路探针        | 完成                     | `b95f61d0`                   |
| B2 引文发现                                        | **未开工**               | ——                           |

证据档：`docs/evidence/2026-10-28-doi-integrity-four-signal-and-entry.md`、
`docs/evidence/2026-10-29-b3-reading-state.md`、`docs/evidence/2026-10-29-c1-framework-binary-guard.md`。

## 1 B2 目标（计划档原文）

「**引文发现**（参考文献 + 引用它的论文，含中文源，每条附理由）」现状 `semantic.scholar` 命中 0；
目标：「同查询中英各有命中，每条附理由段」。

## 2 已探明的数据源事实（2026-10-29 01:30 CST 实测，OpenAlex，无 key）

| 事实                        | 读数                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /works/doi:{doi}`      | 直接返回记录（**没有** `message` 包裹），`referenced_works` 53 条（LeCun 2015 样本）                                         |
| 某文被谁引用                | `GET /works?filter=cites:{openalexId}&select=doi,title,language,publication_year` —— 顶层 `results`，**没有** `message` 包裹 |
| 引用量级                    | LeCun 2015 `cited_by_count=84078` ⇒ 必须分页 + 限量，不能整包拉                                                              |
| 中文语言标记                | `filter=language:zh,has_doi:true` 命中 **607,608** 条                                                                        |
| ⚠️ 但 `language` 字段噪声大 | 抽样 5 条里 4 条明显不是中文（JAMA 1968、Elsevier 物理论文、Post‑Fordism 等）                                                |

**结论（写进设计，别踩）**：「中文源」不能只按 `language:zh` 判定。可行判据是叠加三条：
标题中文字符占比、DOI 前缀（如 `10.3760/` 中华医学会、`10.1360/` 中国科学）、期刊语种（OpenAlex `primary_location.source.language`）。
理由段里必须写明是哪一条判据命中的 —— 这正是对标产品不给的粒度。

## 3 施工顺序（与 B1/B3 同一套契约面）

1. `src/shared/references-citation-discovery.ts`：请求/结果类型 + 三条中文判据的纯函数（可单测，零网络）；
2. 主进程模块 `src/main/references/citation-discovery.ts`：OpenAlex 抓取，注入 `fetchImpl`，**每条结果带理由段**；
   失败三分：源不可达（`unavailable`）/ 无命中（`empty`）/ 命中（`found`），绝不把「没连上」当「没有引用」；
3. 新通道 `references:discover-citations`：按 `docs` 里 `contract-surfaces.md` A 节八面逐条落
   （契约目录 → 生成物 → preload+d.ts → 应用命令+Pick → 三处计数 → 四处清单 pin → 运行时 DDL 若有表）；
4. 界面：文献库/详情页一个「发现引用」动作 + 结果列表（每条显示理由段与来源链接），九语 i18n；
5. 真机验证：用 `scripts/probe-framework-binaries.sh` 同款方式起独立 headless，走 RPC 打真实查询，
   中英各一条、各记命中数与理由段，落证据档。

## 4 口径（不许打折）

- 「同查询中英各有命中」= 真机两条查询各返回 ≥1 条**带 DOI 或 OpenAlex id** 的结果，且每条都有理由段；
- 抓取必须限量（`per-page` ≤ 25、最多 2 页），并把「本次只看了前 N 条」写进结果，不许暗示「全部」；
- `unavailable` 绝不读成 `empty`；
- 每条结果附 `sourceUrl`（OpenAlex work 链接），导出/界面可点。

## 5 环境与坑（沿用前一版）

- 仓库 `/Users/totota/purescience`；`main` 已推到 `b95f61d0` 之后
- `typecheck` 需要 `NODE_OPTIONS=--max-old-space-size=8192`；`npm run build` 同
- 改 `prisma/schema.prisma` 后必须 `./node_modules/.bin/prisma generate`
- 新增通道漏掉任一面 ⇒ CI 会在你没跑的分片点名（`renderer-contract-entry-coverage` 会抓「建了没人调」）
- 真机验证：起独立 `--user-data-dir` 的 headless 实例，端口自选，token 在 `~/.purescience/web-token`；
  RPC 形状 `POST /rpc/<channel>` body `{"protocolVersion":1,"args":[...]}`
- 并行执行器 cron 每 2 小时在同一工作树跑：动手前先 `git status`，有未提交改动先判断是谁的

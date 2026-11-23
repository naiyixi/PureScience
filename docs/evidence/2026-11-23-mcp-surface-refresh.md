# v3.1 MCP 五件的重新取证（2026-11-23）

上一轮审计把 v3.1 的证据归到「11-19 之后没再跑」那一档。这份文件是逐个重跑的结果，结论分两类：
**现在重跑过的**（本机，命令可复现）与**CI 持续覆盖的**（每次 P0 都跑，引用的是最新一趟日志）。

## 1.1 `literature` —— 外部客户端真调用（本机重跑，EXIT=0）

```
node scripts/verify/literature-mcp-external.mjs
=== tools/list ===  literature_search / literature_get / literature_cite
=== literature_search: semaglutide obesity === {"errors":[],"count":6, ...}
=== literature_cite: 10.1056/NEJMoa2034577 ===
  "Fernando P. Polack, Stephen J. Thomas, Nicholas Kitchin, et al. Safety and Efficacy of the
   BNT162b2 mRNA Covid-19 Vaccine. New England Journal of Medicine. 2020. 383(27). 2603-2615.
   doi:10.1056/nejmoa2034577."
  location: {"read":"Metadata only","url":"https://doi.org/10.1056/nejmoa2034577","source":"crossref"}
=== literature_get: arXiv 2103.14030 ===
  "Swin Transformer: Hierarchical Vision Transformer using Shifted Windows" · read: "Abstract"
```

远端在墙内不稳，这次是带 `HTTPS_PROXY=127.0.0.1:7897` 跑的；`read: "Metadata only"` 是**如实**的降级
（Crossref 只给了元数据），不是假装读过全文。

## 1.3 `pptx` —— 外部客户端 + Quick Look + 应用自己的解析器（本机重跑，EXIT=0）

```
=== macOS Quick Look === {"producedThumbnail":true,"thumbnailBytes":22444,"stderr":""}
=== app renderer (parseZip) === {"slides":4,"layouts":1,"masters":1}
```

四页中文 deck，Quark 缩略图非空（22,444 字节，`stderr` 空 ⇒ 不是「生成了但报错」），应用自己的渲染器按
`parseZip` 读出 4 页 —— 这与 v3.1 那一列的原始读数一致，且是**刚刚**重跑的。

## 1.2 `library` 与 1.4 的工具面 —— CI 每趟都跑，不是一次性读数

这两件不需要「手动重跑」：`e2e/certification/external-mcp-client.spec.ts`（478 行）就在
`test:e2e:p0` 的目录里，macOS 与 Windows 两条车道每趟都跑。最新一趟 windows P0（run `45031035383`，
job `137240556962`）的日志原文：

```
[f1] tools/list: ["add_reference","archive_session","get_reference","list_project_files","list_projects",
                  "list_schedules","list_sessions","read_session","remove_reference","search_library",
                  "session_activity","set_reference_notes"]
[f1-write] target session: e2e-session-1
[f1-write] declined card: {"requestId":"69d527fa-…","sessionId":"e2e-session-1","toolCallId":"e806956b-…",
                           "title":"An outside MCP client asks to archive “First question”", …}
```

即：**12 个工具**逐一对表（不是「有一些」）、写操作**真的停在应用自己的审批卡上**且拒绝后数据不变
（spec 断言）。`windows-x64` 那趟 124 passed / 0 failed 里就包含这两个用例。

**更正**：上一轮我把 1.2 与 1.4 的工具面归进「会腐烂」是过虑了 —— 它们在 CI 里持续被跑。

## 仍然只有一次性证据的两小格

| 格 | 为什么还没进 CI |
| --- | --- |
| 1.4 `session_activity` 的 `running` | spec 只调了读与写，没调这两个只读工具；`running` 要一个**真在飞**的回合，夹具目前没有「把回合挂住」的开关 |
| 1.4 `list_schedules` 读出真定时任务 | 同上，只有单测覆盖映射，真定时任务那次是手工读数 |

这两格是同一件事：给夹具加一个「挂住回合」的开关，然后在外部客户端 spec 里读 `session_activity`。
不假装它们已经覆盖。

# 官方验证器的 profile 覆盖面（2026-11-20）

仪器与上文同一套：`roc-validator` **0.4.2**、venv `/tmp/ps-val-venv`、`abort_on_first=False`、被测包由产品自己的
写出器生成（`/tmp/ps-aff-crate`，作者 `Abel Wang` + 机构 `zerolink Bio` + 机构 URL + 文本许可 `CC BY 4.0`）。

## 装了哪六个 profile、各自读数

| profile                         | REQUIRED 读数                   | 它说什么                                                    |
| ------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| `ro-crate-1.1`                  | **0 条**                        | 全过                                                        |
| `process-run-crate-0.5`         | 1 条（`2.1`，出现两次后修一半） | 只差「根实体声明它 conformsTo 本 profile 的版本化永久链接」 |
| `workflow-ro-crate-1.0`         | 2 条（`3.1`、`4.1`）            | 必须有 `mainEntity` 指向 Main Workflow                      |
| `workflow-testing-ro-crate-0.1` | 3 条                            | 同上 + 测试 profile 自己的要求                              |
| `workflow-run-crate-0.5`        | 4 条                            | 同上 + 运行 profile 自己的要求                              |
| `provenance-run-crate-0.5`      | 4 条                            | 同上 + 溯源 profile 自己的要求                              |

## 结论：只有 `ro-crate-1.1` 适用于我们现在写出的东西

四个 workflow 家族 profile 的 REQUIRED 全部落在同一件事上：**根实体要有 `mainEntity` → Main Workflow**。
我们导出的不是工作流，是一个项目在某个时点的文件集合 —— 没有 workflow 可指。为了让检查变绿而在包里塞一个
`ComputationalWorkflow` 实体，就是**为了让验证器满意而写一个不存在的流程**，这比不合格更糟。

`provenance-run-crate` 同理：它继承 workflow 的 Main Workflow 要求。

## `process-run-crate` 这一条值得单独记：它只差一个「声明」

这是唯一一个看起来够得着的：它只有两条 REQUIRED ——

1. `1_create_action`：`CreateAction` 必须有 `instrument` 指向 `SoftwareApplication` / `SoftwareSourceCode` /
   `ComputationalWorkflow`。**我们真过了**：包里有 `#create-assay.csv`（`CreateAction`），
   `instrument` = `[PureScience 的 SoftwareApplication, #environment-python]`，`result` = `files/assay.csv`。
   这不是空过（不是「没有 CreateAction 所以不检查」），是真的有实体并且满足。
2. `2.1`：根实体的 `conformsTo` 里要有一个 `@id` 指向**本 profile 的版本化永久链接**的 `CreativeWork`。

第 2 条我按形状补了（`conformsTo` 加 `{"@id": "https://w3id.org/ro/wfrun/process/0.5"}`，并写一个同名
`CreativeWork` 实体）再验，读数从 **2 条变 1 条**：一条消掉了，另一条不动。**没找到它到底还要什么**（形状
`sh:class schema:CreativeWork` + `sh:pattern "^https://w3id.org/ro/wfrun/process/.*"` 都按字面满足了）。
在没搞清之前，**不宣称符合 Process Run Crate** —— 「差一条声明」听上去很便宜，但那正是最容易蒙对的地方。

## 如果将来要做 Process Run Crate（SHOULD 级还差这些）

`OPTIONAL` 级读出来，除声明之外我们缺的是（都属「有内容可写」而非「凑字段」）：

- `8.6` Action 要有 `agent`（Person 或 Organization）—— 我们有会话与代理，可以如实指出是谁做的；
- `8.1` Action 要被根实体 `mentions`；
- `8.3` Action 要有 `description`；
- `8.4` Action 的 `endTime` 要 ISO 8601 —— 我们写的是 `2026-09-05T06:31:00.000Z`，与 `datePublished` 当年
  踩的是同一个坑（`Z` 与 `+00:00` 之争）；
- `4.1`/`5.1` 软件要有 `version` 与绝对 URI（PureScience 已有，`#environment-python` 没有）。

## 这份档不覆盖的

- 只跑了这六个 profile 的 REQUIRED 与其中一个的 OPTIONAL；`process-run-crate` 的其余 SHOULD 没逐条过。
- `2.1` 那一条为何在补了声明之后仍然红，**未定因**（可能是检查器对 `conformsTo` 引用的解析，也可能是
  我们对形状的理解有偏差）。记为待查，不记为我们的缺陷，也不记为验证器的缺陷。
  **⚠️ 2026-11-20 就地更正**：已定因，见 `docs/evidence/2026-11-20-process-run-crate-2-1.md` ——
  形状判的是**根实体**（不是元数据描述符），`sh:class` 又逐值判，所以补到描述符上一条都不消。

# Process Run Crate 0.5 的 `2.1` 为什么红：位置在根实体，且每个被引用的 `@id` 都要有实体

2026-11-20。上一篇（`docs/evidence/2026-11-20-validator-profiles.md`）把六个 profile 的 REQUIRED 都量了一遍，
其中 `process-run-crate-0.5` 只差一条 `2.1`，我按形状补了 `conformsTo` 之后读数从 2 条变 1 条，**没搞清还剩什么**，
当时记为「未定因」。这一篇把它定死：读检查器自己的形状定义 + 五个变体各验一遍。

## 仪器与样本

- 验证器 `roc-validator` **0.4.2**，venv `/tmp/ps-val-venv`，`abort_on_first=False`。
- 被测包 **由产品自己的写出器生成**（不是手搓的样本）：`/tmp/ps-aff-crate`，作者 `Abel Wang`、机构
  `zerolink Bio` + 机构 URL、文本许可 `CC BY 4.0`，共 9 个实体。它的根实体（`./`，`Dataset`）**已经**
  写着 `conformsTo: {"@id": "https://w3id.org/ro/crate/1.1"}`，元数据描述符上写的是 RO-Crate 1.1 的版本链接。
- 复算：`python3 docs/evidence/2026-11-20-process-run-crate-2-1.py <crate-dir>`（每个变体都从同一个包
  派生，行与行之间只差「`conformsTo` 写在哪、被引用的 id 有没有实体」）。

## 形状真源（包内逐行）

`rocrate_validator/profiles/process-run-crate/must/2_root_data_entity_metadata.ttl`：

```turtle
sh:targetClass ro-crate:RootDataEntity ;          # ← 判的是根实体，不是元数据描述符
sh:path dct:conformsTo ;
sh:class schema:CreativeWork ;                     # ← 对 conformsTo 的**每一个**值都判
sh:qualifiedValueShape [ sh:pattern "^https://w3id.org/ro/wfrun/process/.*" ] ;
sh:qualifiedMinCount 1 ;
sh:minCount 1 .
```

三处关键：**目标节点是根实体**、**`sh:class` 逐值判**、**至少一个值要匹配 profile 的版本化永久链接**。
一条 property shape 里同时挂着 `sh:class` 与 qualified 两条约束，所以「值不对」与「引用没有实体」会各报一条 ——
这就是基线看到的两条同文消息的来源。

## 五个变体的读数（REQUIRED 级，现取）

| 变体 | 改了什么 | 读数 |
| --- | --- | --- |
| `baseline` | 什么都不改 | **2 条** `2.1`（class 未满足 + pattern 未满足） |
| `descriptor` | `conformsTo` 写到**元数据描述符**（`ro-crate-metadata.json` 那个实体） | **仍是 2 条** `2.1`，且**多出一条** `ro-crate-1.1.5.3`（描述符的 `conformsTo` 必须是 RO-Crate 规格版本） |
| `root-only` | 写到根实体，但被引用的 id 没有实体 | **1 条** `2.1`（pattern 过了，`sh:class` 没过） |
| `root-work` | 写到根实体 + 给 permalink 一条 `CreativeWork` | **0 条** |
| `list-one-entity` | 根实体改成列表（保留 base 声明），但只为 profile 链接写实体 | **1 条** `2.1`（讨论见定因第 2 条） |
| `both-described` | 根实体的 `conformsTo` 变成**列表**（保留 base 声明）+ 给**两个**被引用 id 各一条 `CreativeWork` | **0 条**，且 `ro-crate-1.1` 的判决逐条不变（改前 3 条 RECOMMENDED / REQUIRED 0，改后同样 3 条 / 0） |

`root-work` 之所以也绿，是因为它把 base 声明**覆盖**掉了；那是用丢掉一句真话换来的绿，
`both-described` 才是能落地的形状（保留 `https://w3id.org/ro/crate/1.1`，追加 profile 链接，两个 id 都描述）。

## 定因（三条，都可复算）

1. **位置**：`2.1` 的目标是 `ro-crate:RootDataEntity`（我们的 `./` Dataset），不是元数据描述符。
   写到描述符上不但一条都不消，还会把已经通过的 base `5.3` 弄红 —— 上一轮「补了仍红」就是这一条。
2. **`sh:class` 是逐值判的**：`conformsTo` 一旦变成列表，**每个**被引用的 `@id` 都必须有 `CreativeWork`
   实体；保留 base 声明就必须连 `https://w3id.org/ro/crate/1.1` 也为它写一条实体。两次读数各证一半：
   `root-only`（只有一个值、没有实体 ⇒ 1 条）、`list-one-entity`（两个值、只描述了 profile 那个 ⇒ 1 条）。
3. **pattern 只认 `^https://w3id.org/ro/wfrun/process/.*`**，profile 的版本化永久链接
   `https://w3id.org/ro/wfrun/process/0.5` 正是它，不需要别的写法。

## REQUIRED 之外：`both-described` 上还差 10 条 RECOMMENDED（现取）

| 检查 | 它要什么 | 我们缺的是什么 |
| --- | --- | --- |
| `process-run-crate-0.5.3.2` | Application 要有 `url` | `#environment-python` 没有 URL |
| `…0.5.4.1` | SoftwareApplication 要有 `version` / `softwareVersion` | 同上，内核实体没有版本 |
| `…0.5.5.1` | 软件实体的 `@id` 应为绝对 URI | `#environment-python` 是相对 id |
| `…0.5.8.1` | Action 要被根实体 `mentions` | 根实体现 `mentions` 只有会话 |
| `…0.5.8.3` | Action 要有 `description` | 我们的 `CreateAction` 只有 `name` |
| `…0.5.8.4` | Action 的 `endTime` 要 ISO 8601 | 见下一节：形状只认 `+HH:MM` |
| `…0.5.8.6` | Action 要有 `agent`（Person 或 Organization） | 没写 |
| `ro-crate-1.1.22.1` ×2 | 根实体的 `license` 应指向一个上下文实体 | 我们写的是纯文本 `CC BY 4.0` |
| `ro-crate-1.1.22.3` | `publisher` 应为 Organization | 按既有决定**故意留空**（不替用户主张署名） |

这十条里没有一条是「塞个字段就过」的：`agent` / `description` / `mentions` 是**得有真内容**（谁做的、
做了什么、根实体认领它）；`#environment-python` 的 URL 与版本我们确实拿得出；`license` 要变成实体则会
把用户填的自由文本拧成一个我们编的 URI —— 不做。

## 一个会误导人的形状：`endTime` 只认 `+HH:MM`

`process-run-crate/should/1_create_action.ttl` 的 pattern 是

```
^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2})?$
```

`2026-09-05T06:31:00.000Z`（我们现在写的）**是合法 ISO 8601，却过不了这条**：`Z` 不是它要的 `+HH:MM`。
这与 `datePublished` 当年踩的是同一个坑（`src/shared/ro-crate.ts` 的 `normalizeDatePublished` 就是为它写的，
注释里写明「实测 `ro-crate-1.1.8.4` 在三种导出配置上都红过」）。

一处内部不一致顺手记在这里：**同一份写出器里 `datePublished` 走归一（写成 `+00:00`），`endTime` 没有**
（`src/shared/ro-crate.ts:477` 直接写 `provenance.createdAt`，仍是 `.000Z`）。BASE profile 不查 `endTime`
格式，所以现在不会红；**这一处没有改** —— 改它会动到已在会话手里的 `src/main/ro-crate/**`，
且只有在我们真的要宣称本 profile 时才有意义。要改的形状是明确的：对 `endTime` 复用同一个归一函数。

## 结论：仍不宣称，但配方已在手

- **仍不宣称符合 Process Run Crate 0.5**。理由从「未定因」升级成**已量过的**：REQUIRED 可达（三处编辑），
  但 RECOMMENDED 还有 7 条 profile 自己的 + 3 条 base 的，其中三条要真内容。为了让验证器变绿去写
  `agent`/`description`/`mentions` 而不真有那些内容，就是「为了让检查器满意而写一个不存在的东西」。
- **配方（等 SHOULD 的那些内容真的到位时，按这个形状一次到位）**：根实体的 `conformsTo` 变成列表
  `[{"@id": "https://w3id.org/ro/crate/1.1"}, {"@id": "https://w3id.org/ro/wfrun/process/0.5"}]`，并为
  **两个** `@id` 各写一条 `CreativeWork` 实体。实测该形状：本 profile REQUIRED 0 条、
  `ro-crate-1.1` 的 REQUIRED/RECOMMENDED 逐条与改前相同。
- 上一份证据档里那句「未定因」已被本篇取代；路线图 `docs/plan-2026-11-18-capability-gap-roadmap.md`
  的 v3.5 候选一节就地更正为已定因。

## 这份档不覆盖的

- 只跑了 `process-run-crate-0.5` 的 REQUIRED 与 RECOMMENDED；它的 MAY 级（`may/*.ttl`）没逐条过。
- 样本是一个包（9 个实体）。多文件、多 `CreateAction` 的包没复测 —— `sh:class` 逐值判这条结论不受影响，
  但「有几个 Action 就报几条」的计数没量。
- 验证器只用了 0.4.2 这一个版本；形状来自包内 ttl，换版本要重跑脚本而不是照这份表背。

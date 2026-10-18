# 知识库来源列表：能筛选、能排序（2026-10-19）

提交：`d940bf46`（代码 + 认证 spec + 九语文案）。真机读数取自 `c8cdf626` 之上的隔离工作树
（`git worktree add --detach` + 软链 `node_modules`），主工作区一个字节没碰。

## 一 为什么做这一件

「已登记来源」一页 20 条。来源上百之后，找一个来源只能一页页翻，找「最大的那几个」或者「只看网址来源」
没有别的办法。v2.12.0 把分页做出来时，排期外候选里登记了两条：**面板排序筛选**与 URL 来源的验证频率策略。
后者要产品口径（多久验一次、失败怎么降级），前者离线可判、连锁在渲染层，所以先做它。

## 二 交付

| 面 | 内容 |
| --- | --- |
| 纯函数 | `src/renderer/src/pages/settings/knowledge-source-view.ts`：`filterAndSortKnowledgeSources()` + `isNarrowed()`，无 import 依赖 |
| 面板 | `KnowledgePanel.tsx`：文字筛选（`type=search`）、类型筛选（全部/文件/网址）、排序（登记顺序/名称/体积从大到小）、筛选时的 `Showing {shown} of {total}`、`No sources match this filter.` 独立一句 |
| 文案 | 九语言各 10 键（脚本自证九文件齐平、zh ≠ en、zh-Hant 无简体字） |
| 测试 | 纯函数 8 条 + 渲染 7 条 + 真机认证 spec `e2e/certification/knowledge-panel-filter-sort.spec.ts` |

### 三处取舍（都能被读源复核）

1. **先筛后排，再分页**。页码与「全选本页」都建立在 `visibleSources` 之上：反过来做的话，筛选一改，页码
   指向的仍是宽列表里的第 N 页，而勾选是按行身份记的 —— 「全选本页」会选到读者没看见的行。
2. **「没有匹配」与「还没有登记」是两句话**。寄存器里明明有行、只是这一视图排除了它们；说成「还没有登记
   来源」会把人送去登记一个他已经有的来源。判据写进渲染用例与真机 spec 各一条。
3. **计数只在筛选时出现**。「显示 3 / 128 条」是关于筛选的事实；没筛选时印它，只会教人忽略这一行。

### 复用了什么，没有新建什么

- 名称比较沿用市场列表那条既有口径（`specialist-marketplace-sort.ts`：大小写不敏感 + 数字段按数值比），
  不引入第二套「按名称排」的意见。
- 零新通道、零契约计数涟漪：筛选与排序都作用在面板已经读到的那份 `overview.sources` 上，不碰 store、
  不碰 RPC、不碰模型工具面。

## 三 读数（全部实跑）

| 门 | 读数 |
| --- | --- |
| 纯函数用例 | `knowledge-source-view.test.ts` **8 passed** |
| 渲染用例 | `KnowledgePanel.filter.render.test.tsx` **7 passed**（含「页 2 上改筛选要回到第 1 页」与「计数归零但不借用空寄存器那句话」） |
| 定向 | `src/renderer/src/pages/settings` + `src/renderer/src/i18n` ⇒ **73 文件 / 773 passed / 1 skipped** |
| 全量 | `npx vitest run --maxWorkers=4` ⇒ **1342 文件通过 / 16 skipped（1358）**、**17152 例通过 / 207 skipped**、**exit 0**（206.38s，完整输出 `/tmp/full-vitest-sort.log`） |
| 类型 | `tsc -p tsconfig.node.json --composite false` **exit 0**、`-p tsconfig.web.json --composite false` **exit 0** |
| lint | `npx eslint --no-cache` 改动面 14 文件 ⇒ **0 error / 0 warning**（i18n 九文件里插入块留下的 9 条尾逗号 warning 已 `prettier --write` 清零，`git diff` 只多 9 增 9 删） |
| 推前钩子 | `bash scripts/pre-push-checks.sh` ⇒ **exit 0** |
| **真机认证** | `e2e/certification/knowledge-panel-filter-sort.spec.ts`（先 `npm run build:e2e`）⇒ **1 passed (4.9s)** |

真机那一条不是断言组件自己说的话：三个**真文件**（`alpha-small.md` / `beta-medium.md` / `gamma-large.md`、
体积刻意与名字顺序错开）由应用自己登记并指纹，然后

- 登记顺序 = `alpha / beta / gamma`，此时**没有**计数行；
- 筛 `beta` ⇒ 只剩 `beta-medium.md`，屏上 `Showing 1 of 3`，`alpha` 的节点数为 0；
- 类型筛到 `url` ⇒ 屏上 `No sources match this filter.`，且 `No sources registered yet.` **不出现**、
  计数为 `Showing 0 of 3`；
- 切「体积（大→小）」⇒ 行序变成 `gamma / beta / alpha`；切回「登记顺序」复原。

## 四 边界（不许读成更强）

- **纯客户端**。`listSources` 仍一次返回全部来源；服务端分页仍未做（v2.12.0 已归档的同一条限制，本次未动）。
- **筛选匹配的是行上真正印出来的三个字符串**：名称、位置、网址最终落点。不匹配摘要，也不匹配文件内容 ——
  内容检索仍是「检索」那一段的事，两者不是同一种能力。
- **勾选不随筛选变化**：筛选只是改看得见什么，勾选按行身份记；批量栏里的数字始终是真实勾选数。因此
  「先勾几行、再改筛选、再全选本页」得到的是两批行之和 —— 这是既有语义（全选只作用于当前页），本次未改。
- **名称排序跟随运行时区域设置**（`localeCompare` 不指定 locale，与市场列表同一口径）。非 ASCII 名称的
  先后因此可能因机器语言而异；用例只用 ASCII 名称钉，钉的是「大小写不敏感 + 数字段按数值比」，不钉某种
  语言的排序习惯。
- 真机读数只有 macOS arm64 一份：认证 spec 只在认证车道（`macos-arm64` 构建作业）里执行，Windows 车道
  不跑它。跨平台断言只用 ASCII 名称与 `toHaveText` 的行序，不写宿主路径字面量。

## 五 具名未办

- **URL 来源的验证频率策略**（排期外候选最后一条）：要产品口径 —— 多久验一次、验失败降级成什么、面板
  怎么表述。未开工，未在本轮擅自定。
- 服务端分页（来源上千时的正确形状）：仍未做，仍在 v2.12.0 的「明确没做」里。
- 面板的排序选择不持久化：刷新窗口后回到「登记顺序」。没有证据表明读者需要记住它，所以没有加存储。

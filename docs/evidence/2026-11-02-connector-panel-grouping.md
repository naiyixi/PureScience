# v2.21.2 连接器面板：按领域分组 + 「N 个连接器 · M 个工具」

> 2026-11-02。为什么改：用户看到的是「只有 31 个连接器」。实测 `CONNECTOR_CATALOG` 31 条（现在是 33）、
> 工具 282 条（现在 286）—— 31 是**连接器**数，不是能力数；而面板把 31 行平铺，读者既看不出总数也看不出领域。

## 一 改了什么

1. **每一行带领域标签**（上一轮已交）：`ConnectorMeta.domain` → `ConnectorView.domain`，11 语言里 6 个领域名。
2. **目录区按领域就地分组**（本轮）：同一列表里，领域变化处插入一行小标题（`data-slot="connector-domain-heading"`），
   不新增一层折叠 —— 再点一次才看到内容的分组，等于把「31 行」换成「6 个要点开的盒子」。
3. **面板显示总数**（本轮）：`{connectors} connectors · {tools} tools`，两个数字都来自**注册表**：
   `CONNECTOR_TOOL_COUNTS` 由 `ALL_TOOLS` 归约得出，经 `ConnectorView.toolCount` 传到渲染层。
   面板不做二次统计，也不用「搜索后剩下的条数」当总数 —— 搜索时总数仍然如实。

## 二 为什么工具数必须来自注册表

`README` 里那句「N 个连接器 / M 个工具」已经由一个守卫（`readme-connector-count.test.ts`）钉在 registry 上，
本轮加两个连接器时它当场变红（31→33、282→286），三份文件（README.md / README.en.md / ROADMAP.md）都被要求同步。
面板如果再自己数一遍，就会在任何一次筛选/搜索下给出第二个数字 —— 两个数字只要有一次不一致，读者就不知道信哪个。
所以这里是同源：`ALL_TOOLS` → `CONNECTOR_TOOL_COUNTS` → `ConnectorView.toolCount` → 面板求和。

## 三 读数

- `registry.test.ts`：**8 passed / 8**（含「每个连接器必须带 domain」的守卫）。
- `ConnectorsPanel.render.test.tsx` + `registry.test.ts` + `translation-quality.test.ts`：**62 passed / 62**。
- 面板计数（本机注册表）：**33 个连接器 · 286 个工具**；领域分布 genomics 12 / structures 7 / omics 3 / clinical 4 /
  literature 4 / tools 2（structures 从 6 变 7 是因为 LIPID MAPS 落在这一组）。

## 四 没做的

- 领域 section 还**不能单独折叠**（只做分组标题）。理由写在上面：多一层折叠会把「31 行」变成「要点 6 次的盒子」。
- 面板没有把「自定义 MCP 服务器」计入这两个数字 —— 它们不是内置连接器，混进去会让「N 个连接器」失去定义。
  自定义服务器由它自己那一段的计数负责。

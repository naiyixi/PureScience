# 外部客户端用文献检索（MCP）

一个 stdio MCP 服务器：`literature_search` / `literature_get` / `literature_cite`。给 Claude Desktop、Cursor、或任何脚本用，**不需要桌面端开着**——检索走 PubMed、arXiv、Crossref 的公开接口。

## 启动

服务器是同一个二进制（打包后即应用本体），加一个参数即进入 MCP 模式：

```bash
# 开发态（先 npx electron-vite build）
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron out/main/index.js --purescience-literature-mcp

# 打包后（macOS）
ELECTRON_RUN_AS_NODE=1 "/Applications/PureScience.app/Contents/MacOS/PureScience" --purescience-literature-mcp
```

## 接到 Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "purescience-literature": {
      "command": "/Applications/PureScience.app/Contents/MacOS/PureScience",
      "args": ["--purescience-literature-mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

## 三个工具

| 工具                | 入参                                                                               | 返回                                                                  |
| ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `literature_search` | `query`（也接受 DOI）、`sources`（默认 pubmed+arxiv）、`limit`（默认 10，上限 50） | `records[]` + `errors[]`；某一路失败不影响其余，失败写在 `errors`     |
| `literature_get`    | `identifier`：DOI / PMID / arXiv id / PubMed、arXiv 链接                           | 一条记录，或 `{"error":"unrecognised-identifier"}`                    |
| `literature_cite`   | 同上                                                                               | `citation`（可直接粘贴）+ `location{read,url,source}` + `identifiers` |

每条记录都带 `read: "Abstract" | "Metadata only"`——**它说明这段文字是读过摘要的，还是只有书目信息**。引用时把 `location` 一起交出去，读者就能核。

## 边界（说清楚，免得被当成万能检索）

- **只有三个来源**：PubMed、arXiv、Crossref。没有 CNKI / 万方 / 维普（那些走订阅接口，见导入侧 `docs/verification/2026-11-18-specialist-marketplace-install.md`）。
- **不读全文**：`read: "Abstract"` 表示读到摘要；PubMed 的 OA 全文、PDF 解析都不在这个服务器里。
- **不访问本机文献库**：那是另一个服务器（`library`）的事，这里刻意不混。
- **限流**：NCBI 无 API key 时 3 请求/秒量级；`literature_search` 一次会打 3 个请求（esearch + esummary + efetch）。
- **DOI 判定**：只有 `10.` 开头的才算 DOI。MEDLINE 把出版商条目号写在同批标签里（`88/4/401M [pii]`），存成 DOI 会让每次跳转 404。

## 自检

```bash
npx electron-vite build
node scripts/verify/literature-mcp-external.mjs
```

脚本就是一个外部客户端：spawn 子进程 → `tools/list` → 三个工具各调一次，全部打到真实接口。任一环节失败会以非零码退出。

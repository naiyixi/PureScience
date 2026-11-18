# 外部客户端用本机文献库（MCP）

`purescience mcp` 这个桥已经把 app 的能力暴露给外部客户端（Claude Desktop、Cursor、脚本）。文献库这一组在 1.2 加入：读两条、写三条。

**和 `literature` 那个服务器的区别**：`literature` 查的是公开索引（PubMed / arXiv / Crossref），不需要 app 在跑；这一组读写的**是本机库里的记录**，所以必须连到正在运行的 app。

## 工具

| 工具                  | 风险   | 入参                                                                                              | 返回                                                             |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `search_library`      | 读     | `project`、`query?`、`limit?`（默认 25，上限 200）                                                | `total`（限制前命中数）、`returned`、`truncated`、`references[]` |
| `get_reference`       | 读     | `project`、`referenceId` 或 `doi`                                                                 | 一条完整记录（含 citationKey、摘要片段、笔记、是否挂 PDF）       |
| `add_reference`       | **写** | `project`、`title`、`sessionId`、`authors?`、`year?`、`venue?`、`doi?`、`pmid?`、`url?`、`notes?` | 新记录 id + citationKey                                          |
| `set_reference_notes` | **写** | `project`、`sessionId`、`referenceId`、`notes`                                                    | 写入后的笔记                                                     |
| `remove_reference`    | **写** | `project`、`sessionId`、`referenceId`                                                             | `removed: true`                                                  |

`project` 可以是项目 id，也可以是项目的准确名称。

## 为什么写工具一定要 `sessionId`

写操作不走「供应商一句话就动数据」的路：它们和 `archive_session` 一样，先在 app 里弹一张审批卡，人点了才执行。**卡只能停在某个会话里**——没有会话，卡无处显示，调用只能被拒（`approval-unavailable`）。所以写工具要求你给一个**该项目的会话 id**（用 `list_sessions` 取），而不是让 app 猜。

`sessionId` 不合法时，拒绝发生在弹卡之前，且分开命名：

- `session-not-found` —— 没有这个会话
- `session-not-in-project` —— 会话属于别的项目，卡要显示在改动落地的地方

## 行为约定（都有测试）

- **空 `query` 会被拒**，而不是当「查全部」。模型若把 `""` 当过滤器发过来，直接拿到整库再引用是错答案。要列全部就不传 `query`。
- **`truncated` 明确标注**：命中 26 条、限额 25 时，返回 25 条并 `truncated: true`，`total: 26`。客户端不能因为拿到 25 条就说「库里没有」。
- **重复不写**：同一 DOI（忽略大小写）或同名标题已在库里 → `duplicate-reference`，且**在弹卡之前**拒绝，不让人为一次无变化的写点同意。
- **笔记相同不写**：`no-change`。
- **DOI 只认 `10.` 开头**：`88/4/401M [pii]` 这类出版商条目号会被 `invalid-argument` 拒掉，不会存成 DOI 让后续跳转 404。
- **卡上显示的是解析后的记录**，不是原始入参——批的人看到的是库里将要写成什么。

## 怎么连

外部客户端通过桥启动，而不是直接打 HTTP：

```json
{
  "mcpServers": {
    "purescience": {
      "command": "purescience",
      "args": ["mcp"]
    }
  }
}
```

app 在跑时会发布端点（`~/.purescience-project/external-mcp.json`，权限 0600）；app 没跑时桥会退出码 3 并说明原因。

无窗口环境下批准一张卡：

```bash
purescience permissions            # 列出待批
purescience approve <id> --option <optionId>    # 批准
purescience approve <id> --cancel               # 拒绝
```

## 自检

```bash
node scripts/verify/library-mcp-external.mjs <project> <sessionId>
```

脚本就是一个外部客户端：经桥连上 → 查空库 → 加（等审批）→ 中文检索 → 按 DOI 读 → 改写笔记（等审批）→ 删除（等审批）→ 复核为空。审批它自己在另一个进程里用 `purescience permissions` + `approve` 回答。

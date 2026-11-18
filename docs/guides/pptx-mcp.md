# 外部客户端生成演示文稿（MCP）

`--purescience-pptx-mcp` 是一个独立的 stdio MCP 服务器：把一份大纲写成真正的 PresentationML（.pptx）文件，也能把已有 deck 读回来。**不需要桌面端在跑**——写 deck 是纯函数，字节只由大纲决定（无时钟、无主机名、zip 时间戳固定），所以同一份大纲永远产出同一个文件。

## 工具

| 工具          | 入参                                                                                                 | 返回                                               |
| ------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `pptx_create` | `title`、`sections[{heading, bullets[]}]`、`outputPath`（绝对路径，`.pptx`）、`subtitle?`、`author?` | `{ ok, path, bytes, slideCount, sha256Input }`     |
| `pptx_read`   | `path`（绝对路径）                                                                                   | `{ ok, slideCount, slides[{heading, bullets[]}] }` |

上限（写死在校验里，超了具名拒绝）：60 页、每页 12 条要点、单段文本 2,000 字、整份 40,000 字。

## 接入

```json
{
  "mcpServers": {
    "purescience-pptx": {
      "command": "/Applications/PureScience.app/Contents/MacOS/PureScience",
      "args": ["--purescience-pptx-mcp"]
    }
  }
}
```

源码运行时：

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron out/main/index.js --purescience-pptx-mcp
```

## 刻意不做的事

- **不原地编辑已有 deck**。slide XML 里带着版式、图片、主题引用，改一段文字同时保住其余部件是另一件工作；这里给的是「读出来 → 重建」这条路。`pptx_read` 存在就是为了让这条路可用，而不是假装能直接改。
- **不替你编作者**。`author` 只在调用方真的有时才写进 `dc:creator`；没给就不写字段，不写空串。
- **不写相对路径**。相对路径会落在客户端的 cwd，不是用户以为的地方；`outputPath` 必须是绝对路径，父目录会自动建。

## 拒绝都是数据，不是异常

`{ ok: false, refusal: '...' }` 里的取值：

| refusal                                                                       | 触发                                    |
| ----------------------------------------------------------------------------- | --------------------------------------- |
| `output-not-absolute`                                                         | 给的是相对路径                          |
| `output-not-pptx`                                                             | 结尾不是 `.pptx`                        |
| `title-empty` / `sections-empty` / `section-heading-empty`                    | 大纲不成立（writer 自己的拒绝原样透传） |
| `too-many-sections` / `too-many-bullets` / `text-too-long` / `deck-too-large` | 超上限                                  |
| `write-failed`                                                                | 磁盘问题                                |
| `not-found` / `not-a-pptx` / `unreadable`                                     | 读的时候文件不在、不是 zip 包、读不动   |

## 自检

```bash
node scripts/verify/pptx-mcp-external.mjs /tmp/pptx-verify
```

脚本就是一个外部客户端：真子进程 stdio → `tools/list` → `pptx_create` 写到嵌套目录 → 比对磁盘字节 → `pptx_read` 读回 → 用 **macOS Quick Look** 生成缩略图（系统级阅读器）→ 再用 app 依赖的渲染器 `parseZip` 解析，报告 slide/layout/master 数量。

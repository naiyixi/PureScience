# v2.6.0 真机读数：知识库四把工具（模型自己选工具）

日期：2026-10-17
版本：v2.6.0（发版提交 `release: v2.6.0`）
执行方式：`npx playwright test e2e/knowledge-live.spec.ts`（opt-in，凭据只从环境变量进，缺则 skip）

## 这一片证明什么、不证明什么

证明：**模型会在没人点名工具的情况下，自己选用这四把工具，并且它拿到的引用可以复算。**
不证明：模型每次都会这么做（这是行为，不是合同）；也不证明检索质量（词法，且这一版没有语义源）。

提示词里**不出现任何工具名**，只给一个文件夹路径和一句话：把这个文件登记为来源、也登记它所在文件夹、
按 TP53 检索、把文件夹渲染成文档并报告列了几个文件。选哪把工具、按什么顺序，全部由模型决定。

## 实机读数（原始输出，两把工具各一段）

```
Tool · purescience_knowledge_knowledge_search
INPUT  { "query": "TP53" }
OUTPUT {
  "status": "ok",
  "mode": "lexical",
  "degradation": "semantic-source-unconfigured",
  "verification": "checked",
  "coverage": { "indexed": 1, "pending": 0 },
  "results": [{
    "label": "cohort.md",
    "locator": { "kind": "file", "path": "…/knowledge-notes/cohort.md", "startLine": 2, "endLine": 2 },
    "sha256": "5c47f7faa6909056c66fa2890119bbe7c66788add0a0d1b1e52b86361cb0564b",
    "matchedBy": "lexical",
    "score": 1,
    "lexicalOnly": true
  }]
}

Tool · purescience_knowledge_knowledge_render_wiki
INPUT  { "folder": "…/knowledge-notes" }
OUTPUT {
  "state": "written",
  "content": "# …/knowledge-notes\n\nEvery line below cites the file it came from and the digest of that file as it is now.\n\n| File | Location | sha256 | Bytes |\n| --- | --- | --- | --- |\n| cohort.md | …/cohort.md | c60a2637c5535178f2a95ae3774635a9a07d1bd9dddf3a946d521b6b65db538d | 85 |\n",
  "entries": 1
}
```

两个摘要语义不同，各自与测试进程的独立求值逐字符相同：

| 来源 | 摘要 | 覆盖范围 |
| --- | --- | --- |
| `knowledge_search` | `5c47f7fa…564b` | 被引用的那一行 |
| `knowledge_render_wiki` | `c60a2637…538d` | 整个文件（85 B） |

`coordinator` 侧另有一处不算数的读数：模型有一次先跑了 `ls -la` 再调工具（同一会话里 `Ran a command,
ran 2 tools`）。它没有影响结果，但这说明「模型会先看一眼磁盘」是真实行为，不该被脚本假设掉。

## 实现分工（为什么不是两份实现）

这一版之前，自主执行器已经把 store、有界词法端口（`knowledge-lexical-port`）、组合根
（`knowledge-module`）与词法/语义融合（`shared/knowledge-fusion`）做完了，外面没有任何一条路能走到它们。
本片只做那一段：RPC 白名单与四个分支、能力挂载、身份目录、四把 stdio 工具、会话提示投影。检索走既有端口，
装配走既有组合根；重复实现被刻意排除。

## 三次自我打回（都留在这里）

1. **等 `Ran N tools` 聚合行会随机红** —— UI 有时聚合、有时不聚合，而每把工具自己的行始终在。改为等工具行。
2. **wiki 输出读得太早** —— 工具行出现后输出还要一拍，读到空就判失败。改为轮询到 `state=written`。
3. **第一次真机红在构建产物** —— `out/` 还是加第四把工具之前的构建，模型如实说「本会话没有 wiki 工具」，
   被应用自带的 Auditor 点出未交付。改完源码必须先 `electron-vite build` 再跑真机。

## 明确没做

- URL 来源检索每次查询重新取回正文，离线用不了；「检索读登记时的副本、验证仍走网络」列为下一项，
  因为它要先解决「缓存不能给自己盖章」这件事。
- 知识库在窗口里没有界面：登记与检索目前只经由模型工具。窗口入口要动渲染端契约清单，留给下一片。

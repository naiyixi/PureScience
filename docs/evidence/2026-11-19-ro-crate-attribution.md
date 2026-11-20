# 4.3 导出署名与许可：第三方读校验读数（2026-11-19）

## 验的是什么

上一份第三方读档（`2026-11-18-ro-crate-third-party-read.md`）暴露的缺口：导出包里**没有 `author`、没有
`license`**——写入器早就支持 `creators`/`license`，但导出处理器从不传，设置里也没有这两栏的来源。

本轮补的是「真实来源」：设置里两栏（作者/机构、默认导出许可）→ 导出时逐字进 crate；**没设过就不写**。

## 仪器

| 读者                          | 版本   | 说明                                       |
| ----------------------------- | ------ | ------------------------------------------ |
| `rocrate`（ELIXIR 参考实现）  | 0.16.0 | Python 3.13 隔离 venv，依赖取 TUNA 镜像    |
| `pyld`（通用 JSON-LD 处理器） | 3.3.0  | 同一 venv；上下文用官方 1.1.3 本地副本喂入 |

`pyld` 首次运行时 w3id 拒了默认抓取（`loading remote context failed`），改为把官方上下文
（`https://w3id.org/ro/crate/1.1/context`，v1.1.3，164 403 字节）先落盘再自定义 loader —— 读的是同一份
官方上下文，不是我们的解释。

## 三个包，三份读数

用**真实写入器**（`writeRoCrateExport`）生成，不是手搓 JSON：

| 包        | 配置                               | rocrate 0.16.0                              | pyld 3.3.0                                                                                            |
| --------- | ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `with`    | 作者 `Abel Wang`，许可 `CC BY 4.0` | author `["Abel Wang"]`；license `CC BY 4.0` | author `["http://example.org/base/#author"]`；license `["http://example.org/base/CC BY 4.0"]`；悬空 0 |
| `url`     | 同上，许可填 SPDX URL              | author 同上；license `CC BY 4.0`            | author 同上；license `["https://spdx.org/licenses/CC-BY-4.0.html"]`；悬空 0                           |
| `without` | 两栏都没填                         | author `null`；license `null`               | author `[]`；license `[]`；悬空 0                                                                     |

结论：

1. **两个独立实现都读出了非空的 `author` 与 `license`**——判据成立。
2. **没填就不写**：`without` 包里两个实现都读不到这两个字段（键不存在，不是空串）。这正是「不猜默认值」的读数形式。
3. 引用不悬空：两种读者下 `dangling` 都是 0；`#author` 与许可实体都在 `@graph` 里（9 实体 vs 7 实体，差的就是这两个）。

## 一个照实的短处

许可栏是**自由文本**。填 `CC BY 4.0` 时，`pyld` 展开得到 `http://example.org/base/CC BY 4.0` —— 一个含空格的、
不是合法 IRI 的标识。`rocrate` 照样读出 `CC BY 4.0`，所以判据没破，但这不干净。**填 SPDX URL 就干净**
（`url` 那一行：`https://spdx.org/licenses/CC-BY-4.0.html`）。界面占位符已经同时给了两种写法，并鼓励填 URL。

没有替用户改写：把一个自由文本许可证「补成」某个 SPDX URL 就是猜，而猜错许可证比缺许可证严重。

## 复现

```bash
# 1) 用真实写入器生成三个包（临时取证用例，不入库）
npx vitest run src/main/ro-crate/attribution-evidence.test.ts
# 2) 两个读者各读一遍
/tmp/ps-rocrate-venv313/bin/python /tmp/ps-attr-read.py
```

读数原文：`/tmp/ps-attr-readings.json`（本档表格即其摘要）。

## CI 读数（HEAD `8911b7cb`）

| 作业                                                          | 结论                             |
| ------------------------------------------------------------- | -------------------------------- |
| Windows Full Test（8 分片，Windows 11 x64）                   | **success**（run `44511623602`） |
| Nightly → build / Verify（lint + typecheck + test + package） | **success**（run `44511623653`） |
| Scheduled Regression                                          | **success**（run `44518152558`） |
| Nightly → Build linux-x64 / windows-x64 / macos-x64           | success                          |
| Nightly → Build macos-arm64                                   | 打包仍在跑（与本项判据无关）     |

新增两条通道会让四处「清单用例」变红，这是它们该有的行为：应用命令总数 382→384、本地 Web 380→382、
远程失败关闭 141→143、契约目录 509→511、投影 388→390、preload 暴露面 509→511、本地 Web 可调用面
418→420、设置页区块 8→9。每处都在提交里写明「为什么多这两条」，而不是把数字改到绿。

本地全量：`18945 passed | 229 skipped (19174)`，`1512 passed | 31 skipped (1543)` 个文件，0 失败。

## 边界

- 只覆盖两个第三方实现（ELIXIR 参考库 + 通用 JSON-LD 展开），没有跑官方 `rocrate-validator` 的完整 profile 校验。
- 作者按 `Person` 写（一条 `#author` 实体）。用户填的是机构名时，语义上更接近 `Organization`；这一轮**不猜**，
  留给下一版做「作者类型」选择，或干脆按用户输入的写法保留 Person。

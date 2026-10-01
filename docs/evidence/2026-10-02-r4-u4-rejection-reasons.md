# R4-U4 真机取证：「为什么不是表」的理由与判定同源（2026-10-02）

承接 `7d520f0c`（R4-U4 代码 + 单测，CI 双绿）。单测只能证明**分支**写得对，不能证明
**真解析出的条目**会让抽取与理由说同一句话。本轮把三个真 PDF 送进运行中的应用，走它自己的通道读出结果。

方法：隔离实例（`PURESCIENCE_STORAGE_ROOT=/tmp/ps-q1-root`、`PURESCIENCE_WEB_PORT=44185`、
`npm run dev:headless`），全部经应用自身通道（loopback RPC + `web-token`）驱动，不点界面、不改用户配置。

## 一、隔离配方（含一处必须做对的细节）

```bash
# 配置根（DB/sessions/settings/web-token）
mkdir -p /tmp/ps-q1-root && printf '{"dataRoot": "/tmp/ps-q1/data"}\n' > /tmp/ps-q1-root/settings.json
PURESCIENCE_STORAGE_ROOT=/tmp/ps-q1-root PURESCIENCE_WEB_PORT=44185 npm run dev:headless
```

- **`dataRoot` 必须显式钉住**：`PdfService` 的 `storageRoot` 取的是**数据根**（`src/main/ipc.ts:1701`
  `storageRoot: resolveDataRoot()`），只设 `PURESCIENCE_STORAGE_ROOT` 时数据根仍会落到用户真实的
  `~/PureScience-DEV`，`.pdfs/<docId>.json` 会写进真实根。`settings.json` 里的绝对 `dataRoot` 是
  `repository.ts:861-873` 接受的唯一形式（相对路径被丢弃）。
- 可用素材确实是本机现成的：`~/.purescience-project/runtime/envs/default-python/bin/python3`
  （reportlab 5.0.0 / matplotlib 3.11.0）造真 PDF；`pdf:open` 接受绝对路径。

## 二、三份真 PDF 与读数

`pdf:open` → `pdf:tables`（真 MCP 工具的同一条服务路径），三个文档**同一实例连续读**：

| 文档（页） | 候选 | 读数 |
| --- | --- | --- |
| `prose_then_blank.pdf`（散文段 / 空页） | **0** | `rejectedPages` **字段存在**：第 1 页 `reason='too-few-columns'`、`counts={columns:1, itemCount:5, rows:5, spanningRows:0}`；第 2 页 `reason='blank-page'`、`counts={columns:0, itemCount:0, rows:0, spanningRows:0}`；两页都带 `thresholds={minColumns:2, minRows:2}` |
| `table_only.pdf`（1 页真表） | **1** | `page=1 method=text-layer-row-column-clustering rows=6 columns=4 confidence=high`；`rejectedPages` **字段不存在** |
| `table_then_prose.pdf`（真表 + 散文页） | **1** | 同上 1 条候选且 `rejectedPages` **字段不存在**——扫描里确实有一页没出候选，但理由被**整段抑制**（不是空数组） |

判据（`VERDICTS`）：`{"prose_then_blank": true, "table_only": true, "table_then_prose": true}`。原始输出留存
`/tmp/ps-q1/q1-probe.out.txt`。

三条读数的意义各不相同，缺一条都证明不了这件事：

1. **散文页**：`columns=1` 正是"一行一段话"的几何事实，理由是拿**同一次测量**算出来的数（`itemCount=5` 与
   5 行一致），不是另写一套推断。
2. **空页**：走的是"页面文本本身为空"这条**更弱方法**的分支（`blank-page` 与 `no-positioned-text` 的区分），
   计数全 0 是**真的量到的 0**，不是缺失。
3. **表 + 散文**：这条是**抑制规则**的证伪点——若实现写成"只要有页没出候选就附理由"，这里会带上一页的理由。

## 三、隔离证明（真实数据根全程未被写）

| 位置 | 读数 |
| --- | --- |
| `/tmp/ps-q1/data/.pdfs/` | **3** 个文件（`ba5e5f4c21eb1ee7` / `9e33cadde4a3a388` / `27186c9f38786250`），时间戳均为本次 |
| `~/PureScience-DEV/.pdfs/` | **18** 个（测前基线同为 **18**），最新一个仍是 **Sep 23 17:56**，本次未新增 |

## 四、没做与边界

- **面板的浏览器级读数未取**：`PdfTablePanel` 渲染逐页原因那部分是**组件渲染用例**（`PdfTablePanel.render.test.tsx`）
  覆盖的，本轮没有在真浏览器里把预览面板点开看一遍。理由：本条验收口径（队列 Q1 第 4 点）指的是**工具读数**
  的前后对比；面板需要"建项目 → 让 PDF 进工作区 → 打开预览 → 切到表格页"的界面旅程，属另一条取证线。
  ⇒ **如实记为待取证**，不写成"界面已实机验证"。
- 本轮的散文/表格 PDF 都是**矢量文本**页；扫描件、图片版表格不在本条范围内（那是方法边界，`method` 字段会说明）。

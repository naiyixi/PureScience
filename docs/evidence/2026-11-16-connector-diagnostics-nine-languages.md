# 连接器配置诊断的 34 个码进九语（2026-11-16）

## 一 问题

自定义连接器的配置导入/导出预览把解析器的诊断行原样印在屏幕上；解析器为每个码拼一句**规范英文**
（日志与它自己的用例都读那一句）。界面语言是中文、日文、德文的读者，看到的仍是英文的红色诊断行。
上一轮把「系统文件面板」与「系统横幅」两族的英文分别搬进了九语，这一族量最大：`connector-template.ts`
里 34 个码、每条都带变量（出问题的字段路径、上限、期望类型、冲突的名字）。

## 二 做法

| 层                                                                   | 改动                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/settings.ts`                                             | `ConnectorTemplateDiagnostic` 增可选 `params`（该句需要的值，如 `expected`/`max`/`field`/`value`/`kind`）；规范英文 `message` 保留不动 |
| `src/main/settings/connector-template.ts`                            | 34 处诊断构造点把值放进 `params`；句子本身一个字符没改                                                                                 |
| `src/renderer/src/pages/settings/connector-diagnostic-copy.ts`（新） | 码 → 字典键 + 值的映射；**缺参数或缺码返回 `undefined`**，调用方整句回落规范英文                                                       |
| `ConnectorImportView.tsx` / `ConnectorExportView.tsx`                | 诊断行改读该映射并用 `t(key, values)` 渲染；导出预览里三处英文字面量（`Command`/`Server URL`/OAuth 与密文名提示）一并改读字典          |
| 九语字典                                                             | 新增 37 个 `connectorImport.diag.*` + 4 个 `connectorExport.*`/`common.*` 键，九语齐平                                                 |

三条设计判据：

1. **不解析句子翻译**。面板拿的是码和值，不是从英文句子里抠词；句子结构变了也不会让译文错位。
2. **未知即整句回落**。字典不认识这个码、或这条诊断缺它需要的参数，就显示规范英文——宁可英文整句，
   也不要「`name` 超过 个字符。」这种半句。这条由用例双向钉住（未知码、缺 `path`、缺 `max`、缺 `value`
   各一条断言）。
3. **两种语言分支各成键**：`type` 的 string/array/object 三态、身份冲突的「撞名字 / 撞 ID」两态，
   各自一个键，而不是在译文里塞条件词——译者看不到代码，塞进去的分支他翻不出来。

## 三 门禁（本机实跑）

| 环                                                             | 读数                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 定向 vitest（新表 + 两个面板的渲染套件 + 解析器 + 连接器设置） | **4 files / 67 passed**                                                                                                         |
| i18n 全套（含 `translation-quality.test.ts`）                  | **5 files / 57 passed**                                                                                                         |
| 双 typecheck（`--composite false`）                            | node **0** / web **0**                                                                                                          |
| `npx eslint --no-cache .`（全仓，同 CI 口径）                  | **0 error / 94 warning**（与本轮之前同数，本笔文件 0/0）                                                                        |
| 全量 vitest `--maxWorkers=4`                                   | **1486 files passed**、31 skipped（1517）；**18647 passed**、228 skipped（18875），exit 0（上一笔 1484/18632 ⇒ +2 文件 +15 例） |
| 真机认证 spec                                                  | `e2e/certification/connector-diagnostic-language.spec.ts` **1 passed (14.8 s)**，读数见 §四                                     |

## 四 真机读数（真窗口、真入口、真文件）

`npm run build:e2e` 后跑该 spec。路径：把界面语言置为 `zh-Hant` 并重载（读者在 设置 → 一般 → 语言
里做的同两步）→ `設定` 按钮 → 设置对话框 → 连接器 → `新增連接器` → `匯入組態` → 向真实的投放区
**投一个真实的文件**（`dragEvent` 带真实 `DataTransfer`/`File`，走面板自己的 `dataTransfer.files` +
`file.text()` 路径）→ 读屏上的诊断行。

```
[connector-diagnostic-language] window reloaded in zh-Hant: the Settings entry reads 設定
[connector-diagnostic-language] rows=1 row="name 超過 128 個字元。" canonicalEnglishOnScreen=false
```

读数的分量在两处：① 屏幕上那一行是**九语字典的繁体句子**，填进去的 `128` 是解析器自己算出的上限
（不是 spec 塞给界面的字符串）；② 规范英文 `name exceeds 128 characters.` 在整屏上**不存在**——
只断言「有字出现」的写法，在面板根本没翻译时也会通过，所以这一条是反向的判据。

## 五 边界与具名未办

- **八种非英文行没有母语审校**（我写的，术语对齐已上线的九语字典）。`zh-Hant` 已由
  `translation-quality` 的简体字扫描与「不得等于英文」两条守过；语法细腻度仍可能有可改进处。
- **不覆盖两处抛错文案**（`ipc.ts` 的 `showOpenDialog` 标题已在上轮搬走；`connector-template.ts` 里
  `throw new Error(...)` 那几处仍是英文，它们走的是渲染层的错误横幅而不是诊断行，属另一族，已在前
  一轮具名立案）。
- **规范英文那句话仍是日志与解析器用例的唯一真相**：本单元不是把英文改成中文，而是让**屏幕**按读者的
  语言拼句；英文界面渲染结果与改动前逐字相同（用例按 34 个真实无效文档逐个比对，防的正是「顺手改词」）。
- 装机版随下一次发版生效。

# 系统文件面板的文案进九语（2026-11-16）

## 〇 开工核对（防重做 + 并发 + 该谁做）

- `git fetch` 后 `origin/main = fcfcb0bd`（与本地同）；工作树只有三份**不是本轮的**未跟踪证据档
  （`docs/evidence/2026-11-0{1,4}-*`，不碰）。
- 上一轮 §五 三条：① `fcfcb0bd` 的 `Nightly` 与 `Windows Full Test` 按完整 40 位 SHA **双双 success**；
  ② 公证第 13 次读数见 §四；③ 候选（a）「`src/main/**` 其余用户可见文案」经 grep 落地成两类：
  一处**错误句**（不是对话框）与一族**文件面板标题/过滤器**。
- `grep -rn "Save the update installer|Export support bundle|Export session package|Export notebooks by kernel" src/ e2e/`
  只命中下列待改的调用点，没有别的执行体在做同一件事。

## 一 缺口形状：面板标题/文件类型过滤器/按钮写在代码里

系统文件面板由平台绘制，渲染层的 i18n provider 到不了那里。九处入口的**标题**、四个**文件类型过滤器名**、
一对一对话框的**正文与按钮**此前全是英文字面量。上一轮建立的 `native-dialog-strings.ts` 只覆盖两个
`showMessageBox`（搬迁中途退出 / 窗口反复失去响应），文件面板这一族没接上——同族机制已在位、只这几处漏接。

## 二 交付

| 位置 | 改动 |
|---|---|
| `src/main/native-dialog-strings.ts` | 新增 `FILE_DIALOG_STRINGS`（`Record<NativeLocaleCode, FileDialogStrings>`，20 个字段 × 9 语）。英文值与改动前的字面量逐字节相同，**唯一例外**是覆盖确认的**单数分支**：原文 `1 notebook already exist`（复数加了 s、动词没改）在函数化后改成 `1 notebook already exists`，用例把两个分支都钉住。 |
| `src/main/native-file-dialogs.ts`（新） | 11 个导出的纯构造函数，每个接受可选语言码（缺省走 `app.getLocale()` 级联）：连接器配置导入/导出、会话包导入/导出、支持包导出、更新安装包保存、受管文件保存、产物保存、产物目录选择、批注导出（按 `notes`/`annotated-pdf` 两频道）、笔记本按内核导出、覆盖确认。 |
| `src/main/ipc.ts` | 4 处改用构造函数（连接器配置导入/导出、会话包导入、批注导出）。 |
| `src/main/session-package/ipc.ts` | 导出面板改用 `sessionPackageSavePanelOptions`；扩展名仍取自 `SESSION_PACKAGE_EXTENSION` 单一来源。 |
| `src/main/diagnostics/support-bundle-ipc.ts` | 支持包导出面板改用构造函数。 |
| `src/main/update/service.ts` | 更新安装包保存面板改用构造函数。 |
| `src/main/file-save.ts` | 三处（受管文件保存 / 产物保存 / 产物目录）改用构造函数。 |
| `src/main/notebook/save-ipynb-all.ts` | 目录选择与覆盖确认改用构造函数；`ElectronSurface` 的两个对话框参数类型改为 Electron 自己的 `OpenDialogOptions`/`MessageBoxOptions`（原来手抄的子集连平台合法的 `type: 'none'` 都不接受）。 |
| `src/main/native-file-dialogs.test.ts`（新） | 12 个面板 × 9 语的三向断言（读的是本语言那一行 / 英文逐字节等同旧字面量 / 任何非英文行都不得等于英文句）；OS 级联（`de-DE`、`zh-TW`、未知 `pt-BR` 落英文）；覆盖确认的 `defaultId=cancelId=1`、英文单复数、俄语三种形式、中日韩无复数变化；六个调用点不再含旧英文句（剥注释后扫）。 |
| `src/main/native-dialog-strings.test.ts` | 新增表纪律：九语齐、每句非空、非英文不得等于英文、`zh-Hant` 不得夹简体独有字符、13 个面板标题在同语言内互不相同（防「整表抄成一句」）。 |

术语不是新造的：连接器配置 / 支持包 / 会话包的九语用词逐字取自已上线的 `src/renderer/src/i18n/*.ts`
（`settings.importConnectorConfig`、`settings.supportBundle`、`sessions.packageExport.title`），
`Overwrite`/`Cancel` 取自 `settings.specialistOverwriteContinue` 与 `common.cancel`。

## 三 门禁（本机实跑）

| 环 | 读数 |
|---|---|
| 定向 vitest（新表 + 构造器 + file-save + save-ipynb-all + diagnostics + update） | 39 files / 468 passed |
| 双 typecheck（`--composite false`） | node 0 error / web 0 error |
| `npx eslint --no-cache`（本笔 10 个文件） | 0 error / 0 warning（`--fix` 后复跑） |
| 全量 vitest `--maxWorkers=4` | **1483 files passed**、31 skipped（1514）；**18627 passed**、228 skipped（18855），exit 0（上轮 1482/18574 ⇒ +1 文件 +53 例） |
| 变异自证 | ① 构造器里把「保存文件」读成 `saveArtifactTitle` ⇒ 3 条用例红（含英文钉）；② 德语 `connectorFilter` 抄成英文 ⇒ 「非英文不得等于英文」红；③ `zh-Hant` 写成简体「开启档案」⇒ 表纪律用例红并点名 `zh-Hant.saveFileTitle still carries 开`。 |

## 四 公证第 14 次读数（只记读数，不定性）

`notary-status`（`43748320055`，2026-11-15T18:43:08Z，本轮现派发）：**9 笔全 `In Progress`**，最早一笔
`2026-11-13T11:32:48Z` ⇒ **55h10m 零判决**；`probe3.zip`（11-14T08:35Z）仍不是我方提交。与 §三百二十六
的服务级积压定性一致；只能由用户侧查的两项（App Store Connect 协议状态 / 会员状态）不变。

## 五 边界与具名未办

- **无真机窗口读数**：这些面板只在「OS 语言 + 用户真的点了导出/导入」时出现，且 macOS 的 `NSOpenPanel`
  由系统绘制，Playwright 抓不到它的标题。取证 = 真 `app.getLocale()` 级联 + 真构造函数逐语跑；
  装机版随下一次发版生效。**本轮不声称「在屏幕上看见了中文面板」。**
- **八种非英文行没有母语审校**（我写的，术语对齐既有九语字典；`zh-Hant` 已用简体独有字符清单静态扫过）。
- 本轮不覆盖：`ipc.ts:3263` 与 `settings/connector-template.ts:364` 的**错误句**
  `Connector configuration files must be 256 KiB or smaller`（渲染层已有 `settings.connectorTooLarge`
  兜同一事实，属抛错文案而非面板文案，单独立案）；`app-menu.ts` 的 About 面板（应用名 + 版本号，无需翻译）。
- `PDF` 过滤器名不进表：它是格式记号，九语都是这三个字母；只有描述性的 `Text` 进表（德语用 `Textdatei`，
  避免与英文同形而被门禁判成没翻）。

## 六 下一轮第一步

- ① 按完整 40 位 SHA 读本笔两条车道；② 公证再读一次（只报读数）；
  ③ 下一单元候选：（a）上面那两处**抛错**文案是否该走渲染层的 `messageKey` 通道（先核渲染层现在怎么显示
  它们，别造第二套）；（b）`scripts/i18n-hardcoded-audit.mjs` 的语义判据（仪表类，不进产品）。

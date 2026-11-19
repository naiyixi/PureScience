# 九语集合收敛到一份：语言级联不再有四份，两张原生表补回编译期门（2026-11-16）

## 1 为什么要做

「九种语言」这件事在树里有**四份**实现，而且四份的答案不一致：

| 位置                                                            | 原来的实现                                        | 对 `zh-MO` 的答案 |
| --------------------------------------------------------------- | ------------------------------------------------- | ----------------- |
| `src/main/native-locale.ts`（原生对话框、配对页、OAuth 回跳页） | 自写级联，只认 `zh-hant` / `zh-tw` / `zh-hk` 前缀 | `zh`（简体）      |
| `src/shared/app-menu-labels.ts`（应用菜单）                     | 自写级联 + 正则 `^zh-(tw\|hk\|mo\|hant)(-\|$)`    | `zh-Hant`（繁体） |
| `src/shared/tray-labels.ts`（托盘）                             | 自写级联，`includes('hant'\|'tw'\|'hk')`          | `zh`（简体）      |
| `src/renderer/src/i18n/languages.ts`（渲染层「跟随系统语言」）  | 自写级联，返回值可为 `undefined`                  | `zh`（简体）      |

后果不是「少翻了一句」，而是**同一个 OS 语言设置下，菜单画繁体、它旁边的原生对话框画简体**。
另外两张表声明成 `Record<string, T>`：加/漏一种语言，编译器一句话都不说，读者静默拿到英文。
这正是九语工作最容易悄悄失效的那一处 —— 归口参考文档里写的收尾门「`Record<NativeLocaleCode, T>`
才是门，`Record<string, T>` 就是把门关掉」。

## 2 做了什么

1. 新增 `src/shared/locale-codes.ts`：`SupportedLocaleCode`（九码）、`SUPPORTED_LOCALE_CODES`、
   `localeCodeFromTagOrUndefined`（纯函数级联）与 `localeCodeFromTag`（不支持即落英文）。
   **不引 `electron`、不引 `node:*`** —— `src/shared/**` 被 node 与 web 两个 tsconfig 同时编译，
   渲染层也读同一份码。
2. 三份旧级联删除、改为调用共享实现（`native-locale.ts` 保留原有导出名，调用方零改动）。
3. 两张原生表收紧成 `Record<SupportedLocaleCode, T>`：少一种语言**编译不过**。
4. 渲染层 `Language` 从共享类型取；`dictionaries` 是 `Record<Language, …>` ⇒ 共享集合里
   有、字典里没有＝编译错。
5. 顺带修正两处真实的解析差异：`zh-MO` 归繁体（澳门用繁体）、下划线标签 `zh_TW` 按连字符处理。

## 3 门禁读数（本机实跑）

| 环           | 命令                                                                                                                                         | 读数                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 定向用例     | `npx vitest run src/shared/ src/renderer/src/i18n/ src/main/{app-menu,tray,native-locale,native-file-dialogs,native-dialog-strings}.test.ts` | **168 files / 1851 passed**                                 |
| 类型（node） | `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:node`                                                                              | exit **0**（不抬堆会 `Abort trap: 6`）                      |
| 类型（web）  | `npm run typecheck:web`                                                                                                                      | exit **0**                                                  |
| lint         | `NODE_OPTIONS=… npx eslint --no-cache <7 个改动文件>`                                                                                        | exit **0**，0 error 0 warning（不抬堆同样 `Abort trap: 6`） |

新增断言分三层，都在 `src/shared/locale-codes.test.ts` 与 `src/renderer/src/i18n/languages.test.ts`：

- **集合自洽**：九码互异、每码 round-trip 回自身；两张原生表的键集 `toEqual` 九码，字典/选择器
  /`LOCALE_TAG` 三处键集同样 `toEqual` —— 加语言只改一处、漏改一处当场红。
- **不是「英文行抄了九遍」**：对八种非英文语言断言「至少一个标签与英文不同」。运行时无法区分
  「翻译」与「回落」，所以判据必须落在内容上。
- **两侧同一答案**：对 `zh-MO` / `zh_TW` / `zh-CN` / `pt-BR` / `en-GB` / 空串等标签，断言托盘与菜单
  解析到的**就是**共享级联给出的那个码对应的表 —— 这是「两边不可能再各自答一个」的可执行判据。

## 4 这条没有真机读数，原因写在前面

本单元改动的是**纯解析函数与表类型**，可观测差异只对 `zh-MO`（以及下划线形态的标签）存在；
要取这条真机读数得把本机系统语言改成澳门中文，代价与风险都不成比例。所以这里的证据等级是
**函数级 + 编译期**，不是「真窗口读数」。诚实口径：

- 九种语言在 zh/zh-Hant/en/ja/ko/fr/de/es/ru 这些常见标签下的**解析结果与改动前逐项相同**
  （`native-locale.test.ts` 原有的 16 条映射断言全绿即为证），所以这不是一次行为迁移；
- 唯一变化的是 `zh-MO` 与 `zh_TW` 这类标签，变化方向由单一函数保证，两侧不会再有分歧；
- 「界面真的按这个码画」这一层，仍由既有的 `native-file-dialogs` / `native-dialog-strings` /
  `app-menu` / `tray` 用例与下一次发版后的装机实例覆盖。

## 5 边界

- 装机版随下次发版生效。
- 本单元**不改**任何文案内容（只改「怎么选语言」与「表能不能短一行」），所以没有新增 i18n 键、
  不需要翻译审校。

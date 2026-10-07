# RO-Crate：外来 crate 的只读检核（新功能工作单 ① 的落地）

> 实施：自主执行器 cron `2be4405e5dc6`（2026-10-07）。落地方式 = 通道与真入口**同批**（工作单共同红线）。
> 三块式：**① 真实事实**（源码里的既定事实，带 file:line）/ **② 本轮观测值**（本次真跑到的读数）/
> **③ 本轮没证到什么**（具名，不冒充）。

## 一、真实事实（对源核实，不推断）

**缺口**：`validateRoCrate`（`src/shared/ro-crate.ts`）早已存在，并用于本应用写出的**每一个** crate；
但**外来 crate 没有任何入口** ⇒ 界面此前只能写一句「只做导出」（IC48 的结论），且那句在入口落地后**自相矛盾**。

**这次补上的是「只读的那一半」**（工作单 §一 的划界：不做合并进项目、不做导入后改写）：

| 面 | 内容 |
| --- | --- |
| 共享契约 | 新增 `src/shared/ro-crate-inspect.ts`：通道 `ro-crate:inspect-external`、三种拒绝码 `EXTERNAL_RO_CRATE_REFUSALS`（`no-metadata-file` / `unreadable` / `unparseable`）、请求与结果形状。**报告带全部断言**（`RoCrateValidationReport.assertions`），不摘要 |
| 读侧（主进程） | `src/main/ro-crate/import.ts`：只 `readFile(join(cratePath, 'ro-crate-metadata.json'))` 后交给 `validateRoCrate`。**不写、不复制、不导入项目、不开原生对话框**。拒绝码与「已判过的报告」在线上分开 —— 把两者压成一个会**藏掉到底哪条规则没过**，而那正是报告的全部意义 |
| 通道 | `src/main/ro-crate/ipc.ts` 新增 `createRoCrateInspectOwner` / `registerRoCrateInspectIpcHandlers`（具名拒绝非法请求：路径必须是非空字符串）；`src/main/ipc.ts` 装配 `declareElectronAdapter('ro-crate-inspect', …)` |
| 档位 | 目录条目 `['inspectExternal', 'ro-crate:inspect-external', ELECTRON]` —— **桌面档**：crate 是**这台机器**上的一个文件夹 |
| 真入口 | `src/renderer/src/pages/workspace/RoCrateExportDialog.tsx` 的 `[data-slot="ro-crate-inspect"]` 段：路径输入（`data-slot="ro-crate-inspect-path"`）+ 「选择目录…」（`data-testid="ro-crate-inspect-choose"`，走**既有** `storage.pickDirectory`，**不新增原生接缝**）+ 「开始检查」（`data-testid="ro-crate-inspect-submit"`，路径为空时禁用 —— 这是唯一的前置条件，没有第二道隐藏闸门） |
| 报告的呈现 | 摘要 `{passed} of {total} checks passed — {failed} not met.` + **判的是哪份文档**（`ro-crate-inspect-metadata-path`，路径不是译文）+ 未满足项逐条（`ro-crate-inspect-failed-list`：**规则码 + 层级 + 明细**）。层级译成人话（`spec-must` / `spec-should` / `export-contract`）—— 否则会告诉外来 crate 的作者「你的文件不合规」，而那条只是**本应用对自己写出的 crate 的期望** |
| 三种拒绝 | 各自具名（`no-metadata-file` / `unreadable` / `unparseable`），`role="alert"`，读侧原文留在下一行；拒绝**不渲染成报告**（`ro-crate-inspect-result` 不出现） |
| 失真文案同批改写 | `roCrate.export.exportOnly`（**9 语全改**）：从「仅支持导出 —— 还不能导入或校验外来 crate」改为「这里负责写出 crate；外来的 crate 也能在这里做**只读**检查，而且不会被导入任何项目」 |
| 去重（顺手） | `src/main/ro-crate/import.ts` 原先自带一份 `RO_CRATE_METADATA_FILENAME`，而 `src/shared/ro-crate.ts:35` 早有同名常量 ⇒ 改引共享那一份；原先三份自备的类型也收敛到共享模块 |
| 九语 | `roCrate.inspect.*` **15 键 × 9 语** + 改写 1 键；覆盖 **3750 键 × 9 语 = 100.0%**，zh ≠ en、繁体无简体残留、未新增 pending 条目 |

**契约 pin（按失败原文逐个追平，不预猜）**：目录 `472→473`、本地 Web 不可用档 `77→78`、preload 可调用面清单 `+1`（`roCrate.inspectExternal`）、
核心契约 `234→235`（其中 requests `196→197`）、`generated-source-omissions` `+1`；`check:web-api-map` 通过。

## 二、本轮观测值（全部实跑，读数即结论）

| 门禁 | 读数 |
| --- | --- |
| 渲染套件 `RoCrateExportDialog.render.test.tsx`（本轮 +6 条，共 18 条） | **18 passed** |
| 定向 + 契约族（`src/main/ro-crate` · `src/preload` · `src/shared` · `src/renderer/web` · `pages/workspace` · `src/main/web-service` · 两个 composition 套件 · `runtime-ipc`） | **291 文件 / 3181 passed｜1 skipped** |
| **全量 vitest**（`--maxWorkers=4`） | **1227 passed｜16 skipped（1243）**；`15841 passed｜204 skipped（16045）`；497.85 s；**exit 0** |
| 双 typecheck（node / web） | **exit 0**（`NODE_OPTIONS=--max-old-space-size=4096`；本机内存吃紧下的工具进程堆上限） |
| `./node_modules/.bin/eslint --no-cache .` | **0 error / 122 warning**（本单元触碰的文件 **0 problem**） |
| `npm run check:web-api-map` | **exit 0** |
| `bash scripts/pre-push-checks.sh` | **全部通过**（敏感词扫描 / README 版本 / CHANGELOG / 双语同步） |
| **真机读数** `e2e/certification/ro-crate-export.spec.ts` | **2 passed (21.9s)**，`E2E_EXIT=0`；日志三行见 §三 |

**本轮抓到并当批修掉的一条真错**（vitest 看不见、只有 `tsc` 结构性拦得住）：
`src/preload/index.test.ts` 里这份测试自备的桥接子集类型只有 `roCrate.exportProject`，而新用例调了 `a.roCrate.inspectExternal`
⇒ `TS2339`。**修法是把新方法补进那份夹具的类型**（不是把断言改弱、也不是改成可选）—— 与「py 夹具缺必需属性要补桩」同一条纪律。

## 三、真机读数（**已取**）

命令与前置：`rm -rf out/main out/preload` → `npm run build:e2e`（**built in 35.50 s**、exit 0）→
`./node_modules/.bin/playwright test e2e/certification/ro-crate-export.spec.ts --workers=1 --reporter=line`
（e2e 实例读的是 e2e 产物；开工时 swap 已用 9.3 G，期间空闲物理页涨到 9.7 万页 ≈1.5 GB，具备重建余量）。

**结果：`2 passed (21.9s)`，`E2E_EXIT=0`**（既有那条导出用例 + IC45 的拒收用例一起跑，两条都不是新开文件）。三行读数（原文）：

```
[ic48] the dialog states what it does with a crate from elsewhere
[ic48] the read-only half judged this run’s own crate clean
[ic48] rules named on screen: ["metadata-file-descriptor-present· required by RO-Crate 1.1\nno CreativeWork with a RO-Crate conformsTo",
 "metadata-descriptor-id· required by RO-Crate 1.1\ndescriptor @id: undefined",
 "metadata-descriptor-type· required by RO-Crate 1.1",
 "root-date-published-iso8601· required by RO-Crate 1.1\ndatePublished: undefined",
 "root-name-and-description· recommended by RO-Crate 1.1",
 "metadata-descriptor-about-root· required by RO-Crate 1.1\nabout: undefined",
 "metadata-descriptor-conforms-to-profile· recommended by RO-Crate 1.1\nconformsTo: undefined",
 "crate-describes-at-least-one-payload· expected by this app of its own crates\npayloads: 0, actions: 0, software: 0"]
```

**这三行各证明什么**：① 那句「外来 crate 也能在这里只读检查、且不会被导入任何项目」**在真窗口里是原话**；
② 同一份面板对**本次运行自己写出的 crate** 判「全部通过」——「外来路径能读通自家产物」这半边成立；
③ 故意违规的 crate 在屏上**逐条点名**规则码 + 层级 + 明细，且条数与同一份文档经 `validateRoCrate` 算出的失败集合**逐条相符**
（spec 里就是这么断言的），另加两条：检查前后 `ro-crate-metadata.json` **逐字节相等**（只读）、违规 crate 旁边**不出现**「全部通过」。

**⚠️ 取证过程本身抓到一条会红的缺陷（已当批修掉）**：spec 第一版把路径输入写成了 `getByTestId('ro-crate-inspect-path')`，
而组件给那个输入的是 **`data-slot`**（本仓 `data-testid` 与 `data-slot` 混用＝「元素不存在」）⇒ 真机 `locator.fill` **超时 30 s 失败**
（那一次 `1 failed | 1 passed`），而**渲染套件全绿**。改为 `dialog.locator('[data-slot="ro-crate-inspect-path"]')` 后 `2 passed`。
⇒ 这条正是「未跑过的 spec 不许当已验」的实证：**它会在 CI 的 mac 认证作业里红**。

## 四、本轮没证到什么（具名，不冒充）

- **原先的一条设计边界（已由下一笔关闭，2026-10-07）**：彼时只读检核读的是 `ro-crate-metadata.json`、
  **不重算 payload 字节** ⇒ 依赖 `payloadPaths` / `payloadDigests` 的三条断言（`file-sha256-matches-copied-bytes` /
  `file-content-size-matches-copied-bytes` / `every-payload-described`）在那条路上不出现（导出态 30 条 / 检核态 27 条）。
  **现已补齐**：只读侧也遍历 payload 目录、流式复算 sha256/大小，并把两个 payload 输入交给同一份
  `validateRoCrate` ⇒ 两侧规则面**相同**。落地与读数见
  `docs/evidence/2026-10-07-ro-crate-inspect-payload-bytes.md`。
- **「不导入任何项目」这半边**：由**代码读证**（`src/main/ro-crate/import.ts` 无写入调用）与
  「检查前后 crate 元数据逐字节相等」的真机断言共同承担；「项目侧的产物/文件计数不变」这条更强的读数**未取**
  —— 它需要一次「检查外来 crate 前后对比项目文件清单」的夹具，本轮没铺。
- **只读检核的三种拒绝码**（`no-metadata-file` / `unreadable` / `unparseable`）在本轮真机上**只由渲染套件覆盖**：
  e2e 里没有造这三种坏路径（`unreadable` 在真机上要 root/权限配合，本机 `readFile` 对目录的错误码随平台而异）
  ⇒ **不冒充已由真机验证**。

## 五、复跑命令（照抄即可）

```bash
cd /Users/totota/purescience
rm -rf out/main out/preload            # 本仓规矩：重建前先清
npm run build:e2e                      # e2e 实例读的是 e2e 产物，只跑 build:web 会让读数落在旧渲染包上
./node_modules/.bin/playwright test e2e/certification/ro-crate-export.spec.ts \
  --workers=1 --reporter=line
```

判定：`2 passed` ⇒ 收口；红则先读**失败的是哪条断言**（`[ic48]` 前缀的 console 行给出屏上原文），
按「失败文件是否被本笔碰过」判真伪，**不许把 jsdom 读数写成真机读数**。

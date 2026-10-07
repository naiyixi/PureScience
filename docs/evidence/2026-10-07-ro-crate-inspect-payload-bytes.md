# RO-Crate：只读检核也复算 payload 字节（补齐 27 → 30 的那三条断言）

> 实施：自主执行器 cron `2be4405e5dc6`（2026-10-07 第二笔）。上一笔（外来 crate 的只读检核，见
> `docs/evidence/2026-10-07-ro-crate-external-inspection.md`）留下一条**具名边界**：只读那一侧读的是
> `ro-crate-metadata.json`，**不重算 payload 字节** ⇒ 依赖 `payloadPaths` / `payloadDigests` 的三条断言
> （`file-sha256-matches-copied-bytes` / `file-content-size-matches-copied-bytes` / `every-payload-described`）
> 在那条路上不会出现，同一份 crate 在导出态是 **30 条**、在只读检核态只有 **27 条**。本笔把这条边界关掉。
>
> 三块式：**① 真实事实** / **② 本轮观测值** / **③ 本轮没证到什么**。

## 一、真实事实（对源核实，不推断）

**为什么原先只有 27 条**：`inspectExternalRoCrate` 调的是 `validateRoCrate({ document })`——
`src/shared/ro-crate.ts:945` 与 `:974` 两个 `if` 都以「调用方有没有传 payload 输入」为门，
不传就**连规则都不生成**。所以 27/30 不是文案问题，是**规则面本身少了一截**：一个 payload 早已被改坏的
crate，在只读那一侧会得到「本应用能套用的检查全部通过」。

| 面 | 内容 |
| --- | --- |
| 新增（单一来源） | `src/main/ro-crate/digest.ts`：`sha256Hex`（写侧原本私有在 `export.ts:44`，现两侧共用）与 `digestOfFile`（**流式**哈希，`lstat` 先判类型，**符号链接不跟随**、读不到即返回 `undefined`） |
| 读侧补齐 | `src/main/ro-crate/import.ts`：`listPayloadPaths`（走 `<crate>/files/**`，跳过符号链接）+ `declaredPayloadIds`（文档声明的 `files/**`）+ `insideContentRoot`（**逃逸路径一律不读**）⇒ 现在调 `validateRoCrate({ document, payloadPaths, payloadDigests })` |
| 写侧去重 | `src/main/ro-crate/export.ts` 删掉自带的 `sha256Hex`，改引 `./digest` —— 两侧必须对「文件的 sha256」是同一件事，比较才成立 |
| 共享注释更正 | `src/shared/ro-crate.ts` 的 `payloadPaths` 注释原写「actually written（实际写出的）」⇒ 改为「写侧传自己刚写的、只读侧传外来 crate 真正持有的」 |
| 无契约涟漪 | **零新通道、零新命令、零新 i18n 键**：三条规则码早已在共享校验器里，界面按「规则码 + 层级」渲染（层级译成人话），所以没有 pin 级联 |

**三条新出现的断言的语义（对读侧而言）**：

- `file-sha256-matches-copied-bytes` / `file-content-size-matches-copied-bytes`：文档声明的 payload
  若**缺失、是目录、是符号链接、或读不出来** ⇒ 没有 digest ⇒ 该规则**具名失败**（不是静默跳过）。
- `every-payload-described`：`payloadPaths` 取**磁盘上真实存在的** payload ⇒ 一个「躺在 `files/` 里、
  文档却没描述」的文件会被**具名点名**。

## 二、本轮观测值（全部实跑，读数即结论）

| 门禁 | 读数 |
| --- | --- |
| `vitest run src/main/ro-crate`（本轮 import 套件 4 → **10 条**） | **27 passed｜1 skipped**（skipped 是既有 `evidence.capture.test.ts` 的 `describe.skipIf(!ENABLED)`） |
| `vitest run src/main/ro-crate + RoCrateExportDialog.render.test.tsx` | **45 passed｜1 skipped**（5 文件） |
| 双 typecheck（node / web） | **exit 0** |
| `./node_modules/.bin/eslint --no-cache .` | **0 error / 124 warning**（本轮新增的 2 条 prettier warning 已当批改掉；触碰文件 0 problem） |
| **真机读数** `e2e/certification/ro-crate-export.spec.ts` | **2 passed (33.4s)**，`E2E_EXIT=0`（`npm run build:e2e` → built、exit 0） |

**本轮新增的 6 条用例（`src/main/ro-crate/import.test.ts`）**，其中 5 条拿**应用自己刚导出的真 crate**
当输入（`writeDurableVersion` + `writeRoCrateExport`，不是手搓文档）：

1. **规则面相等**：只读侧报的断言条数 === 写侧自己那次校验的条数，且三条 payload 规则**都通过** ⇒
   「读文档不读 payload」这种回退会被这条直接抓住（它等于少 3 条）。
2. **篡改字节被点名**：导出后改写 `files/assay.csv` ⇒ `file-sha256-matches-copied-bytes` 失败且明细里带路径。
3. **声明了却没有的文件被点名**：删掉 payload ⇒ 由**字节比较**那条点名（而不是「未描述」那条）——
   两条规则回答不同问题，用例把分工钉住。
4. **未描述的多余文件被点名**：往 `files/` 扔一个 `leftover.bin` ⇒ `every-payload-described` 失败并带路径。
5. **绝不读到 crate 之外**：文档声明 `files/../outside.txt`，并**照抄那份外部文件的真实 sha256/大小** ——
   一个会跟随该路径的读侧会得到完美匹配、报「通过」；实测该规则**失败并点名**该 id ⇒ 证明没往外读
   （这条用例的判据只有在「它若读就会通过」时才有意义）。
6. **符号链接不跟随**（`skipIf(win32)`，Windows 建链接需特权故具名跳过，不静默通过）：`files/alias` 指向
   crate 外的文件、声明用目标的真实摘要 ⇒ 同样**失败并点名**。

**真机那两条收紧（本轮同时改的）**：① 自家 crate 那一半现在断言屏上摘要 === **spec 自己从磁盘算出的**
`{passed} of {total} checks passed`（此前只断言 `0 not met`）——**若只读侧仍少判 3 条，这条会红**；
② 违规 crate 那一半的**屏上计数逐字**等于 spec 用同一份文档、同一组 payload 输入算出的
`{passed} of {total} checks passed — {failed} not met.`。

## 三、本轮没证到什么（具名，不冒充）

- **真机只覆盖「干净 crate / 元数据坏 crate」两种输入**：篡改字节、缺文件、多余文件、逃逸路径、符号链接
  这五种**都由单测覆盖**（用的是应用自己导出的真 crate），e2e 里没有为它们铺夹具 ⇒ **不冒充已由真机验证**。
- **`payloadPaths` 的目录遍历没有显式上限**：本仓既有遍历（`src/main/storage/usage.ts`、
  `src/main/skills/materializer.ts`）同样不设上限，本笔与它们一致；一个病态目录（十万级文件）会让这一步变慢。
  **未测**，如实记在这里，不声称「已处理」。
- **macOS 的 `.DS_Store`**：若用户点选的 crate 目录被 Finder 浏览过、`files/` 里多出一个 `.DS_Store`，
  `every-payload-described` 会把它点名为「未描述的 payload」。这是**如实报告**（它确实是文件），
  但没做过专门取舍 ⇒ 记为已知边界。
- **payload 极大时的耗时/内存**：哈希是流式的（不整份读入），但**超大 payload 的端到端耗时未测**。

## 四、复跑命令（照抄即可）

```bash
cd /Users/totota/purescience
NODE_OPTIONS=--max-old-space-size=4096 ./node_modules/.bin/vitest run src/main/ro-crate
rm -rf out/main out/preload && npm run build:e2e
./node_modules/.bin/playwright test e2e/certification/ro-crate-export.spec.ts --workers=1 --reporter=line
```

判定：单测 `27 passed`、真机 `2 passed` ⇒ 收口。

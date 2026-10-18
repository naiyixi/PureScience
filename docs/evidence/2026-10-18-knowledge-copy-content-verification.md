# 副本要先证明自己是原样（2026-10-18）

提交：`d2db698e`（`feat(knowledge): 副本先证明自己是原样才被采用 —— 读前验摘要、清扫按内容重算、对不上的单独成桶`）
基线：`0f53c422`（v2.14.0）

## 一、为什么做这一件

v2.10.0 的发布正文里，这条限制是**我们自己写下的**：「清扫按摘要名匹配，不重算内容（内容被改但名字未变的
副本会被保留）」。v2.12/v2.13/v2.14 都没动它，排期档 §三 一直记着「仍开」。

它不是一条洁癖，而是**引用会不会说谎**的问题：一份副本存成 `<data root>/knowledge/contents/<sha256>`，
读取时按名字打开。名字在磁盘上是可以被改内容的（就地编辑、从别的机器恢复、半截 rsync），一旦如此，
检索就会把**来源指纹从未覆盖过的字节**当作命中返回，屏上还带着那个指纹——一份自证的错。

同一个缺口还有第二个制造者，而且是产品自己：`createKnowledgeModule.readUrlText` 在副本读不到时
**无条件**把刚取回的正文写到那个名字下。页面已经变了的话，写进去的就是「名字说谎的副本」——
清扫要清的那种东西，由读取路径亲手制造。

## 二、三个落点（零新通道、零契约计数涟漪）

| 面 | 改法 |
| --- | --- |
| 读 | `readVerifiedCopy()`：读副本前重算 sha256，**不符按缺失处理**（不是把篡改字节端上屏），再走原来的启发式自愈 |
| 写 | 自愈只在「取回字节的摘要 == 登记指纹」时才落盘；不符就地返回正文、不写盘（这一条才是断根） |
| 清扫 | `sweepContents()` 逐份重算摘要：对不上的**删除**并计入新桶 `mismatched`；删不掉进 `failed`；五桶相加仍 = `scanned` |

共享形状：

- `KnowledgeCopySweep` 新增 `mismatched: string[]`（与 `removed` 分桶：「没人引用」和「内容与自己的名字不符」
  是两种病，要两种处置）；
- `KnowledgeSweepRecord.mismatched?: number` **可选**——旧记录没有这一项读数，「当时没查」不等于「查了是 0」，
  面板因此对旧记录一个字都不印。

界面：清扫结论改成两句并列，`sweptMismatched` 只在 `mismatched > 0` 时出现，且当没有别的发现时**单独成句**
（「没有可清理的未引用副本」不会与一次删除并排出现在屏幕上）。记录行同理只在 `> 0` 时追加。
九语言各新增 1 键（脚本自证九文件齐平、zh ≠ en）。

## 三、读数（都实跑）

| 门 | 命令 | 读数 |
| --- | --- | --- |
| 定向单测 | `npx vitest run src/main/knowledge src/renderer/src/pages/settings src/renderer/src/i18n` | **82 文件 / 823 passed / 1 skipped** |
| 全量单测 | `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run --maxWorkers=4` | **1355 文件 / 17337 例：1338 文件通过、17129 例通过、207 skipped；1 例红**（见下） |
| 那 1 例红的归属 | `GlobalSearchDialog.test.tsx > sends the chosen sender filter…`（`query.mock.calls.at(-1)` 的断言） | 本单元**没碰**该文件；单文件隔离跑 **3/3 全部 39 passed**；全量那轮机器 load 37.9、swap 11.03 G/12.29 G（打包版 app 与会话的 claude 同跑）⇒ 按负载敏感记档，不当回归 |
| 类型（node） | `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.node.json --composite false` | exit 0 / 0 错 |
| 类型（web） | 同上 `-p tsconfig.web.json` | exit 0 / 0 错 |
| 改动面 lint | `npx eslint --no-cache <19 个改动文件>` | exit 0 / 0 problems |
| 推前钩子 | `bash scripts/pre-push-checks.sh` | **exit 0**（品牌零命中、README 双语一致、清单合规、53 个脚本入口可解析、本次推送 19 个文件 lint 0） |
| **真机认证** | `npm run build:e2e` 后 `npx playwright test e2e/certification/knowledge-copy-integrity.spec.ts` | **1 passed (27.9s)** |

真机 spec 的形状（`e2e/certification/knowledge-copy-integrity.spec.ts`）——两条读数都来自真窗口 + 真 data root，
而且都不是面板自己的那句话：

1. 一个**真的本地 HTTP 服务**在登记时被产品自己取回并落盘 ⇒ 测试进程读那个文件，逐字等于服务端正文；
2. 把那份副本改写成另一段文字（`Zanzibar …`）后再检索：屏上是 `No matches in the registered sources.`
   与 `status no-matches · indexed 1 · pending 0`——`pending 0` 是关键，说明它不是「没索引」，
   而是索引**从页面自己的字节**重建过，而那段文字里没有 `Zanzibar`；磁盘上那份副本又变回了原样（自愈生效）；
3. 再篡改一次并点「清理未引用副本」：屏上
   `1 copy(ies) no longer matched their own digest and were deleted.`，且 `No unused copies to delete.`
   **不出现**；随后测试进程自己 `readdir` ⇒ 目录为空；
4. 之后同一来源仍可检索（`status ok · indexed 1 · pending 0`，屏幕无 `No matches`），副本重新落盘且逐字正确。

## 四、边界（不许读成更强）

- 名字仍然是**摘要**，没有换命名方案；本单元只是让它**可被复核**。
- 校验发生在**读取**与**清扫**两处；索引构建不重算（索引存的是位置，引用在读侧现算，这是既有口径）。
- `mismatched` 的字节计入 `bytesFreed`（实删了），不计入 `removed`（那是另一种发现）。
- 旧清扫记录没有 `mismatched` ⇒ 面板不印，等于「没查过」，不是「查了是 0」。
- 本片不占版本号，随下一个发版窗口走；README 成熟度块与 CHANGELOG 属发版件，本轮未动（v2.14.0 正文保持原样）。

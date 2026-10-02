# R4-U3 连字/软连字符：读取路径实测（2026-10-02）

承接 `r4-u3-rotation-investigation.md` §4 —— 那里只有"本机 140 份真 PDF 0 实例、reportlab 造不出来"，
**没有**决定性读数。本文件补上那次量测，并把"要不要写归一化器"这个决定落到测量上。

## 一、为什么 reportlab 造不出、手写 ToUnicode 就能造

reportlab 的 TTF 子集化会重写 ToUnicode，让 reader 拿到 `f`+`i`、丢掉软连字符 —— **写方根本没写出这些码位**，
不是读取路径在折叠。所以此前"复现不出缺陷"是**夹具的问题**，不构成"无需修"的证据。

`2026-10-02-r4-u3-ligature-fixture.py` 自己写 ToUnicode CMap：把 WinAnsi 未定义的码位
`0x81 → U+FB01`（ﬁ）、`0x82 → U+FB00`（ﬀ）、`0x83 → U+00AD`（软连字符）写进 `/ToUnicode`，
reader 只能从 CMap 学到这些码位的含义 —— 正是这个单元关心的那类文档。夹具是一张真 3 列 × 3 列表格。

## 二、决定性读数：reader 自己就把它们展开了（`disableNormalization` 默认 false）

同一份夹具、同一个 pdfjs（`node_modules/pdfjs-dist/legacy/build/pdf.mjs`）：

| 调用 | `Con<0x81>rmation` 的码位 | `p.Val<0x83>600<0x83>Glu` |
| --- | --- | --- |
| `page.getTextContent()`（**应用当前用的就是这一支**，`pdf-service.ts:449` 无参数） | `C o n f i r m a t i o n` —— U+FB01 **已展开成 f+i** | `p.Val600Glu` —— U+00AD **已丢弃** |
| `page.getTextContent({ disableNormalization: true })` | `C o n U+FB01 r m a t i o n` —— **码位原样送达** | `p.Val600Glu` —— U+00AD **仍然被丢弃**（两种模式都丢） |

第二行是**夹具有效性证明**：连字码位确实进了 PDF、确实到了 reader；第一行说明**连字的展开发生在 reader 内部**
（pdf.js 的 Unicode 归一化），而不是我们哪一层。第三格说明软连字符更彻底：**关掉归一化也不出现在字符串里**
（reader 在拼 `str` 时就把 U+00AD 去掉了），即它根本没有机会到达抽取器。

## 三、应用自身通道的读数（隔离实例 44186，走应用 RPC，非单测）

```
python3 2026-10-02-r4-u3-ligature-probe.py http://127.0.0.1:44186 /tmp/ps-q2-root/web-token
{"scannedPages": 1, "candidateCount": 1, "rejectedPages": null, "rotatedPages": null}
{"page": 1, "rows": 3, "columnCount": 3, "confidence": "high", "columnsPerRow": [3],
 "textHash": "aee19e46bc13098b"}
    cell="Confirmation"  [U+0043 U+006F U+006E U+0066 U+0069 ...]      ← 3 行 3 列、逐格完整
    cell="affinity" / "efficiency" / "Diffusion" / "p.Val600Glu" / "inword"
```

- **真值 3 行 × 3 列，量到 3 行 × 3 列**，`confidence=high`，`columnsPerRow=[3]`；
- **没有一个词被切碎**：`Confirmation`、`affinity`、`p.Val600Glu`、`inword` 都作为**单个格子值**读出，
  连字已展开为 ASCII、软连字符已消失；
- 同一命令连跑两次，读数逐字节相同（md5 一致）—— 不是抖动。

## 四、结论：**无需改**，不写归一化器

单元里"连字（ﬁ/ﬂ）与软连字符切碎单元格词"这一半，在本应用的读取路径上**不可达**：
我们调用的是默认归一化的 `getTextContent()`，U+FB00–FB06 与 U+00AD 在**进入抽取器之前**就已被 reader 处理掉。
写一个永不触发的 `normalizeLigatures()` 就是死代码（纪律禁）。

**具名边界（立案，不写代码）**：若将来有人把 `pdf-service.ts:449` 改成 `disableNormalization: true`
（或换 reader），连字/软连字符会原样进入 `groupRows`/`splitRow`。届时的正确做法不是加归一化器，
而是**继续用默认归一化**；本节与夹具就是那天要用的判据。要在 CI 里钉住它，得断言"我们的调用没关归一化"，
那是对 pdfjs 调参的断言，价值低于它带来的耦合 —— 故不写。

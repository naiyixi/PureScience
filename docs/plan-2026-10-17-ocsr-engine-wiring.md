# OCSR（图 → 结构式）接线：实测台账

这份文档只记**量到的**东西：命令、读数、结论。它服务于两件事 —— 让下一个接手的人不必重走这些弯路；
以及让「两台引擎一致才算数」这条红线有据可依。

## 一、为什么这一路不能凑数

化学结构式这一路的产物会被当成**事实**引用（「这张图是 X 化合物」）。而一台 OCSR 引擎对一张模糊位图会给出
**看起来很像那么回事但错**的 SMILES —— 比「什么都没有」更危险。所以判定放在纯函数里
（`src/shared/structure-recognition.ts`）：

- **至少两台相互独立的引擎**给出同一个（rdkit 规范化之后的）结构 ⇒ `agreed`；
- 只有一台给出结果 ⇒ `recognizer-single-engine`（缺的是**第二台引擎**，不是图像质量，所以两条拒答不共用一个形状）；
- 两台都读了但不一致 ⇒ `recognizer-disagreement`（需**严格多数**，平票不判）；
- 一台都没有 ⇒ `recognizer-unavailable`。

每种拒答都把**每台引擎各自说了什么**原样带出来，让人能自己看，而不是被一个「空」误导。

## 二、产品的识别资产 **就是** DECIMER-V2 的模型（关键事实）

- DECIMER 包自己的源码里（`DECIMER/decimer.py`）：模型 URL =
  `https://zenodo.org/record/8300489/files/models.zip`；
- 产品清单（`resources/model-weights/manifest.json`）里那条资产的
  `revision` = **`zenodo-10.5281/zenodo.8300489`**、`kind` = `structure-recognition`、
  `bytes` = **298,662,033**（= **284.8 MiB** ≈ 引擎自称的 285 MB）。

⇒ **同一份字节**。因此接线不去让引擎自己下载（实测它在 **28 kB/s** 上磨），而是把**产品已经下载并校验过**
的那份链接到引擎期望的位置（硬链接优先），并在输出里回报用的是哪个文件、多少字节。这样「挂模型 revision」
有真实依据：revision 就是产品清单那一条。

## 三、引擎的实测可得性（都是量过的，不是推测）

| 候选 | 读数 | 结论 |
| --- | --- | --- |
| **DECIMER**（TensorFlow） | pip 直连 **2.9/200.5 MB @ 111 kB/s**，连接被打断 3 次重试；换清华镜像后 **25.6 MB @ 13.7 MB/s** | ✅ 装在专设环境 `runtime/envs/structure-recognition`（python 3.12） |
| **MolScribe**（PyTorch） | `pip` 直接失败：`No matching distribution found for torch<2.0,>=1.11.0`（镜像与本机都是 torch ≥2.2） | ✅ 需要**专设 py3.10 环境**（`structure-recognition-molscribe`）；镜像有 `torch-1.13.1-cp310 arm64`（53 MB @ 16.7 MB/s） |
| **OSRA** | conda-forge / bioconda 的 `osx-arm64` 都**没有**；brew 也没有 | ❌ 不可得 |
| **IMAGO** | EPAM 的 mac 控制台版能下（9 MB），但二进制是 **Mach-O universal i386/x86_64** ⇒ 本机 **`Bad CPU type in executable`**；`ggasoftware/imago` 是 C++ 源码（需自编） | ❌ 不可得（除非自编） |

### MolScribe 的两道 ABI 墙（以及怎么过的）

1. `scipy 1.15.3`（pip 轮子）在本机 macOS 27 上 **dlopen 失败**：
   `section '__DATA/__thread_bss' has a zero-fill section type, but offset field is not zero`；
2. 换 conda-forge 的 scipy 1.15 又要 **numpy ≥2**，而 `torch 1.13` 要 **numpy 1.x** ⇒ 互咬；降到
   numpy 1.26 + scipy 1.14 后报 `_fitpack_impl` TypeError —— 根因是 **pip 轮子与 conda 包混在同一个
   site-packages**。

**过法（可复用）**：数值栈**只从 conda-forge 装**（`python=3.10 numpy=1.26 scipy=1.13`），pip 只装
`torch==1.13.1` 与 `molscribe`，并用 **constraints 文件钉住** numpy/scipy 不被 pip 替换。判据是三条实测：
`numpy 1.26.4 | scipy 1.13.1`、`torch 1.13.1 | bridge (3,)`（`torch.from_numpy` 通）、`import molscribe` OK。

## 四、栅格化（图要变成像素才能喂引擎）

主进程原本**没有任何**栅格化能力（无 canvas/sharp，pdfjs 的 `render()` 从未在主进程用过），产品随包的二进制
只有 micromamba，系统也没有 pdftoppm/mutool/gs。选择：**在 python 侧做**（`pypdfium2`，许可宽松、自带
PDFium、pip 轮子，不必动 JS 依赖树与打包配置），脚本随包走 `resources/engines/structure_recognition.py`
（`asarUnpack: resources/**` 已覆盖，解析规矩照抄 `notebook/python_loop.py`）。

**实测读数**：

- 裁切在**像素**层面做（PDFium 的 `crop` 是位图级、原点与顺序都容易读错，而这里的换算必须能被外部复算）：
  应用给的框是 PDF 用户空间（原点左下），Pillow 原点左上 ⇒ 先翻 y 再乘 scale；
- 同一份 PDF + 同一个框 + 同一个 DPI **两跑逐字节相同**（`sha256 94beef1b…`）⇒ 输入指纹可复算的前提成立；
- 200 dpi → 1444×945；400 dpi → 2889×1888；
- **框超出页面时具名拒绝** `bbox-outside-page`：早先写成「静默裁窄」，那会把图裁成**另一张图**却照样被拿去
  识别 —— 正是「照着错的像素给一个很像那么回事的结构式」的入口。

## 五、当前状态与下一步

- 引擎：DECIMER 环境就绪；MolScribe 环境就绪（含 torch 桥接与导入判据）；
- 资产：走**产品自己的下载器**（`downloadLocalParsingModel`，`cacheDir` = 本机活跃数据根
  `~/.purescience`），落定后带 sha256 校验，并链接给 DECIMER；
- MolScribe 的 checkpoint（pip 包不带权重）走 **hf-mirror** 取；
- ④ 的对照夹具：RDKit 画的 `caffeine` / `aspirin` / `glucose_open` 三张真实结构图 + 规范化 SMILES 作为
  ground truth；验收脚本 `/tmp/verify-ocsr.sh`（两台引擎 × 三张图，规范化后比较，一致才高置信）。

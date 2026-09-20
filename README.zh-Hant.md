# PureScience · 繁體中文

> [简体中文](README.md) · [English](README.en.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · **繁體中文**

![真機執行產出的效力曲線 — EGFR T790M 抑制劑排序](docs/demo-verification/egfr_t790m_ic50.png)

*真機跑出來的結果，不是示意圖：這張圖背後的程式碼、參數與環境指紋，逐步歸檔在 [`docs/demo-verification/`](docs/demo-verification/)。*

PureScience 是一套開源的科研工作台：在你自己的電腦上本地運行（macOS、Windows、Linux），用你手上已有的模型供應商，把一句日常語言的任務，變成一段由代理執行的會話——讀檔、跑 Python 與 R、上網檢索、呼叫科學資料連接器。交回來的東西可重現：報告、表格與圖，都連到產生它們的那段活動紀錄。

完整說明（能力清單、模型設定、權限，以及把已知限制寫在旁邊的成熟度段落）在英文版 [README.en.md](README.en.md) 與簡體中文版 [README.md](README.md)。這一頁是短的入口。

## 三步上手

1. **下載** — [最新版本](https://github.com/naiyixi/PureScience/releases/latest)：macOS（Apple silicon 268 MB · Intel 284 MB）、Windows（安裝檔 220 MB）、Linux（AppImage 288 MB · `.deb` 216 MB）。所有安裝檔的校驗值都在同一版的 `SHA256SUMS.txt`。
2. **首次啟動** — 第一次開啟時設定語言與模型供應商；沒有金鑰就不會執行任何東西，也不會把資料送出去。
3. **第一個任務** — 建立專案，用日常語言描述任務，讓它跑。結果會以帶版本、來歷與活動紀錄的產物留下來。

## 差別在哪

每次執行都經得起查，而不是看起來合理：筆記本執行有審計、圖要對照出版級規則檢查、每條記憶都帶著出處，未經你同意沒有任何東西離開你的電腦。目前最強的地方在生物資訊、計算生物學、基因體學、結構生物學與藥物探索，架構可延伸到其他領域。

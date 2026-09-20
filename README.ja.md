# PureScience · 日本語

> [中文](README.md) · [English](README.en.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · **日本語** · [한국어](README.ko.md) · [Русский](README.ru.md) · [繁體中文](README.zh-Hant.md)

![実際の実行から出力された効力グラフ — EGFR T790M 阻害剤を順位付け](docs/demo-verification/egfr_t790m_ic50.png)

*実機で走らせた結果であり、見栄え用の合成画像ではありません。この図の裏にあるコード・パラメータ・実行環境の指紋は [`docs/demo-verification/`](docs/demo-verification/) に工程ごとに記録しています。*

PureScience はオープンソースの研究ワークベンチです。お手元のマシン（macOS / Windows / Linux）でローカルに動き、すでにお持ちのモデルプロバイダーをそのまま使えます。自然な言葉で書いた依頼が、ファイルを読み、Python と R を実行し、Web を検索し、科学データのコネクタを呼ぶエージェントセッションになります。返ってくるのは再現可能な成果物です — レポート、表、図は、それを生んだ活動履歴と結び付いています。

能力・モデル設定・権限・そして既知の限界まで正直に書いた成熟度の節を含む全文は、英語版 [README.en.md](README.en.md) と中国語版 [README.md](README.md) にあります。このページは短い入口です。

## 3 ステップで始める

1. **ダウンロード** — [最新リリース](https://github.com/naiyixi/PureScience/releases/latest)：macOS（Apple Silicon 268 MB・Intel 284 MB）、Windows（セットアップ 220 MB）、Linux（AppImage 288 MB・`.deb` 216 MB）。全パッケージのチェックサムは同じリリースの `SHA256SUMS.txt` にあります。
2. **初回起動** — 初回に言語とモデルプロバイダーを設定します。鍵がなければ何も実行されず、どこかへ送られることもありません。
3. **最初のタスク** — プロジェクトを作り、タスクを日常の言葉で書いて実行するだけ。結果はバージョン・来歴・活動履歴を持つ成果物として残ります。

## ここが違うところ

実行は「それらしい」ではなく検証できます。ノートブックの実行は監査され、図は出版水準の規則に照らして確認され、記憶は出典を持ち、許可なくマシンの外に出るものはありません。現在はバイオインフォマティクス、計算生物学、ゲノミクス、構造生物学、創薬で最も力を発揮し、他の分野へ拡張できる設計です。

# PureScience · 한국어

> [中文](README.md) · [English](README.en.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · **한국어** · [Русский](README.ru.md) · [繁體中文](README.zh-Hant.md)

![실제 실행에서 나온 효력 그래프 — EGFR T790M 억제제 순위](docs/demo-verification/egfr_t790m_ic50.png)

*실기에서 돌린 결과이며, 보여주기용 합성 이미지가 아닙니다. 이 그림 뒤의 코드·파라미터·실행 환경 지문은 [`docs/demo-verification/`](docs/demo-verification/)에 단계별로 남아 있습니다.*

PureScience는 오픈소스 연구 워크벤치입니다. 사용자의 컴퓨터(macOS / Windows / Linux)에서 로컬로 실행되고, 이미 쓰고 있는 모델 제공자를 그대로 사용합니다. 자연어로 적은 작업이 파일을 읽고, Python과 R을 실행하고, 웹을 검색하고, 과학 데이터 커넥터를 호출하는 에이전트 세션이 됩니다. 돌아오는 것은 재현 가능한 산출물입니다 — 보고서, 표, 그림이 그것을 만든 활동 이력과 연결되어 있습니다.

능력·모델 설정·권한, 그리고 알려진 한계까지 솔직하게 적은 성숙도 절을 포함한 전문은 영어판 [README.en.md](README.en.md)과 중국어판 [README.md](README.md)에 있습니다. 이 문서는 짧은 입구입니다.

## 세 단계로 시작하기

1. **내려받기** — [최신 릴리스](https://github.com/naiyixi/PureScience/releases/latest): macOS(Apple Silicon 268 MB · Intel 284 MB), Windows(설치 파일 220 MB), Linux(AppImage 288 MB · `.deb` 216 MB). 모든 패키지의 체크섬은 같은 릴리스의 `SHA256SUMS.txt`에 있습니다.
2. **첫 실행** — 처음 열 때 언어와 모델 제공자를 정합니다. 키가 없으면 아무것도 실행되지 않고, 어디로도 전송되지 않습니다.
3. **첫 작업** — 프로젝트를 만들고 작업을 일상 언어로 적어 실행하면 됩니다. 결과는 버전·출처·활동 이력을 가진 산출물로 남습니다.

## 무엇이 다른가

실행은 그럴듯한 것이 아니라 검증 가능합니다. 노트북 실행은 감사되고, 그림은 출판 수준 규칙에 비추어 확인되며, 기억은 출처를 함께 가지며, 허락 없이 컴퓨터를 벗어나는 것은 없습니다. 현재는 생물정보학, 계산생물학, 유전체학, 구조생물학, 신약탐색에서 가장 강력하며, 다른 분야로 확장 가능한 구조를 갖추고 있습니다.

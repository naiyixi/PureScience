# 门禁里那条红是并行争用，不是代码缺陷 — 读数（2026-10-04）

## 现象

`npm run test:gate`（本机，HEAD = `72d94de2`）落红：

```
Test Files  1 failed | 1197 passed | 16 skipped (1214)
     Tests  1 failed | 15553 passed | 196 skipped (15750)

× durably certifies the codex provider projection for an ACP approved handoff
  src/main/agents/completion-gate.execute-control.integration.test.ts   (22 tests | 1 failed) 14566ms
```

## 判定：争用，不是缺陷。两条读数

1. **单独跑同一个文件**：`22 passed (22)` —— 同一条用例在无并行争用下通过。
2. **仓内早有记载**：`docs/evidence/2026-09-18-default-parallelism-timeouts.md` 把
   `main/agents/completion-gate.execute-control.integration` 明确列在「默认并行下会超时」的那批
   11 个文件里。本文件的注释（`:527-532`）也自述过它对着预算量级做过调整。

## 我这边的自伤（记下来，下次别犯）

这次门禁运行期间，我**同时**起了一次 Playwright/Electron 真机 spec。8GB 机器上两者叠加，
对这个已经贴着预算跑的文件是雪上加霜。**规矩：门禁与真机 e2e 不并发。**

## 处置

- **不改代码**：本条红与被改动的区域（`settings/ipc.ts` 的三条注册、渲染层组件、i18n 字典）无关，
  且单跑即绿。
- **不并入发布判定**：下一次发版运行**不与任何 e2e 并发**地重跑一次门禁；若仍是同一条、且单跑仍绿，
  按「舱内已知争用敏感文件」记录，而不是放宽断言。
- 文件内那条用例本身**没有被改动**——为了让门禁变绿去改它对不上任何事实。

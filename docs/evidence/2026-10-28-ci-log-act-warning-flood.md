# Verify 作业日志里的那 62%：一句 React 警告把日志顶到 12MB

日期：2026-10-28（执行器轮次 §二百五十二）
提交：`2ccb6f8c`（`test(harness): act 环境只声明一处 …`）

## 一 起因与第一手读数

交接档把「**CI 失败原因不可见**」记成：Verify 红时 `gh run view --log-failed` 返回空、
`gh api …/jobs/<id>/logs` 的日志「被截断在 ~94k 行（11MB）中间、看不到汇总」。

先按「读真数据」核这两次读数（作业级日志各自下载、逐行统计）：

| 作业 | 提交 | 结论 | 日志 | 那句警告占 |
| --- | --- | --- | --- | --- |
| `122402006892`（绿） | `6705c088` | success | 12.41MB / 119,643 行 | **77,419 行 / 7.73MB = 62.4%** |
| `122148662592`（红） | `dae37ac3` | failure | 11.86MB / 114,797 行 | **77,421 行 = 67.4%** |

**那条「看不到汇总」在这两份日志上都没有复现**：红的那份在第 114,749 行有
`Test Files 112 failed | 1290 passed | 21 skipped (1423)`，第 114,758 行还有根因
（`Electron failed to install correctly.`）。所以「日志被截断」不是本次要修的东西；
真正成立的是**日志体积**：三次里有两次，三分之二的体积是同一句话。

```
The current testing environment is not configured to support act(...)
```

按文件归属（剥掉 ANSI、按 `stderr | <file>` 前缀归位）：**147 个测试文件**在印它，最集中的三条
`SettingsPage.render.test.tsx` 14,668 行、`ProjectFilesView.test.tsx` 14,508 行、
`ProviderStep.render.test.tsx` 13,964 行。

## 二 根因（读源，不是推测）

`react-dom` 的 `isConcurrentActEnvironment()`（`node_modules/react-dom/cjs/react-dom-client.development.js:16316`）：

```js
isReactActEnvironmentGlobal || null === ReactSharedInternals.actQueue || console.error(
  'The current testing environment is not configured to support act(...)')
```

即：**只要 `IS_REACT_ACT_ENVIRONMENT` 不为真，而当前又在 `act()` 里**（`actQueue` 非空），
每一次被调度的更新都印一句。这不只是日志噪声——React 的 `act()` 在标志为假时**不走并发路径**，
不在这里同步 flush 工作；也就是说那 178 个没有声明的 jsdom 文件，跑的是 React 认为的降级路径。

仓里 **86 个文件**各自抄了一行 `IS_REACT_ACT_ENVIRONMENT = true`（逐文件声明），
`@vitest-environment jsdom` 的文件共 **264 个** ⇒ 剩下的 178 个（其中 147 个真的会印）没有声明。

## 三 改法与自证

1. `test/setup-jsdom-polyfills.ts`：在 jsdom 共用 setup 里声明一次，**按 `typeof window` 判定**
   ——node 环境的测试不该冒充 act 环境。注释里写明为什么（体积读数 + 降级路径）。
2. `src/renderer/src/setup-act-environment.test.tsx`（新，守卫）：在 act 内发一次真实更新，
   断言 `console.error` 里**不含**那句警告、且标志为真。放在 `src/renderer/src/` 是因为
   `test/` 不在任何一个 tsconfig 的 `include` 里（放那里就只有 vitest 转译、没有类型检查）。
3. **变异自证**（去掉声明后守卫必须红）：

```
--- 去掉声明 ---
 × setup-act-environment.test.tsx > declares the act environment once, and an update inside act() does not warn
 AssertionError: expected [ …(2) ] to deeply equal []
 +   "The current testing environment is not configured to support act(...)",
 +   "The current testing environment is not configured to support act(...)",
      Tests  1 failed (1)
--- 恢复后 ---
      Tests  1 passed (1)
```

红的正是那句警告本身，不是别的断言连带。

## 四 本机读数（verbose reporter：与 CI 那份日志同形）

| 面 | 改前 | 改后 |
| --- | --- | --- |
| 三个最大来源（159 用例） | 43,171 行警告 / 3,283,319 字节 | **0 行 / 71,260 字节（-97.8%）** |
| 三个最大来源的用例 | 159 passed | **159 passed** |
| 全部 jsdom 面（264 文件） | —— | **2,685 passed + 1 skipped，0 失败，0 行警告**，耗时 1,070.95s |

门禁：`eslint --no-cache`（2 文件）**0 error / 0 warning**；双 typecheck（`--composite false`，堆 8192）
node **0** / web **0**；`test/vitest-project-partition.test.ts` 与新守卫 15 passed；
`scripts/pre-push-checks.sh` **exit 0**。

## 五 边界（不许读成更强）

- **CI 侧读数（`2ccb6f8c` 的 Verify 作业落定后现取；同一车道、相邻两笔）**：

| `build / Verify` 作业日志 | `6705c088`（改前） | `2ccb6f8c`（改后） | 差 |
| --- | --- | --- | --- |
| 字节 | 12,416,905 | **2,999,734** | **−75.8%** |
| 行数 | 119,643 | **30,568** | **−74.5%** |
| 那句 act 警告 | 77,419 行 | **0 行** | 清零 |
| `Test Files` | 1401 passed \| 24 skipped (1425) | 1402 passed \| 24 skipped (1426) | +1（新守卫用例那个文件） |
| `Tests` | 17,763 passed \| 219 skipped | 17,764 passed \| 219 skipped | +1 |
| `Duration` | 781.49s | 613.82s | −167.7s（**读数，不归因**：执行机与负载未受控） |

- 86 个文件的逐文件声明**保留**：删掉是零行为收益、动 86 个文件的改动；台面上它只是冗余，
  单一来源已经是 setup 里那一行。
- 「`gh run view --log-failed` 为何返回空」这一半本轮量清了：在这个环境里它对**任何**作业都读回 0 字节并退出 0，
  而 `gh api …/jobs/<id>/logs` 给出同样的日志（读数与可读的那条路见 `docs/evidence/2026-10-28-ci-failure-digest.md`）。
  「失败时用 junit + artifact 上传」仍未落地——它要动受保护的 workflow 文件，体积治下来之后不再必要。
- 本机没有复现出「日志被截断」：本机能取到完整 12MB，说明截断发生在远端/工具链一侧，
  与体积正交。

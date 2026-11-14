# 面板把收割的机器枚举直接印给人看：三个 reason 改成句子，未知的照原样显示

日期：2026-11-15（执行器）
触发来源：`docs/evidence/2026-11-15-left-on-remote-unknown-state.md` 收尾时逐字段复核面板渲染（同一单元的下一条）。

## 一 缺口是什么

`FeaturedOutputs` 的「留在远端的文件」列表原来逐字渲染 `entry.reason`：

```tsx
{entry.size_mb} MB · {entry.reason}
```

而 `reason` 的取值是收割分类器写的机器枚举（`src/main/compute/harvest-classifier.ts:42`）：

```ts
reason: 'residency_remote' | 'exceeds_max_file_mb' | 'exceeds_max_total_mb'
```

也就是说用户读到的是 `ssh:biowulf//scratch/reads.bam  1204 MB · exceeds_max_file_mb` —— 一个代码标识符，
而这一整行存在的目的正是**解释「这个文件为什么没下载」**。同一批代码里其余面向用户的文案都走九语字典，
只有这一格漏了（「显性入口有了、文案层的术语没落地」这一类）。

顺带撞出一处**面向 agent 的文档错误**：`resources/skills/remote-compute-ssh/SKILL.md` 把该字段写成
`reason: 'residency:remote'`（那是**收割配置**里的 `residency: 'remote'`），与真实取值不同 ——
agent 若按文档去 filter，恒不命中。

## 二 改动

| 位置 | 改动 |
| --- | --- |
| `src/renderer/src/components/left-on-remote-reason.ts`（新） | 纯函数 `leftOnRemoteReasonLabel(reason, t)`：三个已知 reason → 字典键；**未知 reason 原样返回**（新版本收割写的第四种 reason、手写载荷、历史行都不许被一句笼统话盖掉） |
| `src/renderer/src/components/FeaturedOutputs.tsx` | 列表里的 `entry.reason` 改为 `leftOnRemoteReasonLabel(entry.reason, t)`；文件、大小、顺序一律不变 |
| `src/renderer/src/i18n/*.ts`（九份） | 新增 3 键 × 9 语，逐语言插在 `jobDetail.leftOnRemoteNotListed` 之后；zh 与 en 不同值 |
| `resources/skills/remote-compute-ssh/SKILL.md` | 修正 `reason` 的真实取值并列出三个枚举（agent 侧 `reason` 仍是原样标识符，**只有渲染层翻译**） |
| `src/renderer/src/components/left-on-remote-reason.test.ts`（新） | 三个 reason 全部译出且互不相同；未知 reason 与空串原样返回 |

三条设计判据：

1. **只在渲染层翻译**：`JobResult` / `JobSummary` 里的 `reason` 保持原样标识符 —— agent 靠它分支、证据档靠它复核，
   翻译它等于把契约改坏。
2. **未知值 fail-visible 而不是 fail-silent**：认不出的 reason 直接显示原值。显示原值至少可对照作业记录核查；
   换成「其他原因」则是一句**没人能验证的解释**。
3. **不新增通道、不新增字段**：这是文案层单元，零契约涟漪（`check:web-api-map` 不涉及）。

## 三 门禁（本机实跑，2026-11-15 00:1x CST）

| 环 | 读数 |
| --- | --- |
| `npx vitest run src/renderer/src/components/left-on-remote-reason.test.ts src/renderer/src/components/FeaturedOutputs.render.test.tsx --maxWorkers=1` | **2 files / 10 passed**，exit 0 |
| `npx vitest run src/renderer/src/i18n/translation-quality.test.ts` | **42 passed**，exit 0（九文件齐平、zh ≠ en、zh-Hant 无简体字） |
| `npx tsc --noEmit -p tsconfig.web.json --composite false` | exit 0 |
| `npx eslint --no-cache`（面板 + 新模块 + 两测试 + 九字典） | 0 problems |
| `npx prettier --check`（同上） | 通过 |

新增渲染用例断言 **原始枚举不再出现**（`not.toContain('exceeds_max_file_mb')`）+ **两句话都在** + 文件与大小不变，
所以把实现改回 `entry.reason` 会当场红——这条断言就是这个单元的守卫。

## 四 边界与具名未办

1. **仍没有窗口读数**：与 `docs/evidence/2026-11-15-left-on-remote-unknown-state.md` §五 同一条 —— 本机真实库里
   `ComputeJob` 零行、且当前空闲页 ≈4,300（≈67 MB）/ swap 可用 < 1 GB ⇒ 不起实例。这一格的真机读数配方已写进
   计划档 §三百三十一 §五 第 3 条。
2. **阈值数字不上屏**：`exceeds_max_file_mb` 只知道「超了」，不知道「上限是多少 MB」——`left_on_remote` 条目里
   没有携带阈值。文案因此只说「超过单个文件的下载上限」，不编一个数字；要显示阈值得让载荷带上
   `harvest_config.max_file_mb`，属另一个单元。
3. **`reason` 仍是 `string`**（不是联合类型）：契约层保持前向兼容，新增 reason 不需要改动类型即可流到面板（显示原值）。

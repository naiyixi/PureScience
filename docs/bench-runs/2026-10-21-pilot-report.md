# Pilot report · checkpoint-resume-order · 2026-10-21

第一个真实 run 的完整记录，包括**两条被判为无效的记录**——它们留着是因为"为什么无效"本身就是这次实验最重要的产出。

## 环境

| 项 | 值 |
|---|---|
| 应用 | 构建产物 `out/`（v2.15.3 + 本轮全部改动） |
| config root | `/tmp/ps-pilot-a`（从 `/tmp/ps-v2153-root` 复制，实验后已删除） |
| runtime | `opencode`（claude-code 在本机 egress 到 `api.anthropic.com` 被 `ECONNRESET`，见下） |
| 模型 | `deepseek-v4-flash`（provider 的 anthropic 兼容端点 `api.deepseek.com/anthropic`） |
| 种子 | 1 |
| 权限档 | `full`（headless 没有窗口可点审批卡） |
| 题 | `checkpoint-resume-order`（origin: v0 case，不依赖外部 API） |

## 四条记录

| 时间 | arm | 技能文件实况 | runStatus | Pass@1 | 原子 | 判定 |
|---|---|---|---|---|---|---|
| 16:23 | full-contract | 19/48 有 contract（但为**旧副本**，实际无 contract） | `regraded` | ✗ | 0.33 | **无效**：技能目录是改动前物化的旧副本，标签与实况不符 |
| 16:25 | no-contract | **0 个技能目录**（清空后未重新物化） | `completed` | ✗ | 0.33 | **无效**：这一臂实际是"没有技能"，不是"没有契约" |
| 16:28 | full-contract | 48 个，**19 个带 contract** | `completed` | ✗ | 0.33 | ✅ 有效 |
| 16:34 | no-contract | 48 个，**0 个带 contract**（`PURESCIENCE_ABLATION=no-contract` 生效） | `completed` | ✗ | 0.33 | ✅ 有效 |

两条有效记录的 findings 完全一致：

```
load-before-work : false   (checkpoint_load / checkpoint_save 都没有出现)
resume-named     : false   (没有"恢复…检查点/上次"的表述)
no-silent-redo   : true    (没有把重做说成续做)
```

## 结论（诚实版）

1. **这一题上两臂没有差别**，都是失败、原子通过率 0.33。
2. 原因不是"契约没用"，而是**这题没有被任何契约覆盖**：`checkpoint-resume-order` 背后没有声明
   `requires/produces` 的能力（checkpoint 不是技能，是运行时行为）。臂只能改变技能文件里
   `contract:` 那一行的可见性，对没有契约的题**物理上无从生效**。
3. 因此下一次 pilot 必须换**契约覆盖的题**：`omics-preview-subset-labelled`（`omics-data-preview`
   有契约）或 `figure-axis-discipline`（`figure-style` 有契约、且是 entry point，不依赖外部数据）。
4. agent 的实际行为值得记下：它说"工作区、notebook 和历史产物里都找不到上一批结果"，
   **没有假装恢复**（`no-silent-redo` 通过）——这是这套断言想抓的那种诚实，评分器认了。

## 过程发现（都已变成代码或文档里的前置）

| 现象 | 处理 |
|---|---|
| `POST /api/v1/runs` 报 `Project is required.` | 线上字段是 `project`，不是 `projectId`；runner 已按线上形状发送并有测试钉住 |
| 运行 60 秒后 vitest 报超时，run 仍在跑 | 真实 run 是分钟级；pilot 用例显式设为 25 分钟 |
| headless 启动后 run 卡在 `permission context wait timed out` | headless 无窗口可点卡；pilot 显式传 `permissionProfile: 'full'` |
| `claude-code` runtime 起 session 即 `ECONNRESET`（egress 到 `api.anthropic.com`） | 换 `opencode` runtime（本机已安装，且走 provider 的 DeepSeek 端点） |
| 清空技能目录后不会自动重新物化 | 物化发生在**会话创建**时；臂必须"先清空 → 起会话 → 校验 contract 计数"再判分 |
| 复制出的 config root 里技能是只读的 | 清理前需 `chmod -R u+w` |

## 复现命令（两臂，顺序执行）

```bash
# 臂 A：带契约
rm -rf <root>/opencode/config/opencode/skills <root>/claude/skills
PURESCIENCE_CONFIG_ROOT=<root> PURESCIENCE_AGENT_FRAMEWORK=opencode <app> --purescience-headless
# 起一次 run 后校验：grep -rl '^contract:' <root>/opencode/config/opencode/skills | wc -l  → 19
PILOT_CASE=<case> PILOT_ARM=full-contract … npx vitest run scripts/bench/pilot.test.ts

# 臂 B：不带契约（同一 root，先清空再起）
PURESCIENCE_ABLATION=no-contract PURESCIENCE_AGENT_FRAMEWORK=opencode <app> --purescience-headless
# 校验 → 0，然后同一命令把 PILOT_ARM 换成 no-contract
```

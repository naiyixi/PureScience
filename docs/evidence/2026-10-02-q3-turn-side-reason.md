# Q3 切片：回合侧可读证据 —— 选择器为什么没跑，现在有名字（2026-10-02）

用户拍板："把 `bridgeLease`/`bridgeSkillsAvailable` 做成回合侧可读证据"。本片做的是**可读性**，不是改路由。

## 1. 做了什么（三处，同源）

| 处 | 改动 |
| --- | --- |
| `src/shared/function-models.ts` | 新增具名原因 `'bridge-unavailable'`；并把原因**收敛成一份数据** `FUNCTION_MODEL_EVENT_REASONS`（类型与校验都从它派生） |
| `src/main/acp/turn-skill-owner.ts` | 选择器**没跑**的三条路径各写一条留痕：无桥 → `bridge-unavailable`；没有目录读取器/目录为空 → `call-not-attempted`；**回合已带选中技能不算跳过，不写**（那是设计路径） |
| `src/main/acp/runtime-composition.ts` | 把 `recordFunctionModelEvent` 接进技能的 hook（与配置模型写的是**同一条留痕**，所以"模型没被用"和"选择器没跑"能在同一处读懂） |
| `src/renderer/.../FunctionModelSelect.tsx` + 9 语言 | 新原因的文案（穷尽映射，不加文案编译不过），9 个语种全部实译 |

## 2. 顺手抓到并修掉一个真缺陷：留痕的读取器会把合法原因丢掉

`src/main/function-models/event-log.ts` 的 `isReason` 自带一份原因清单，而**漏了 `'call-not-attempted'`** ——
即：写入时带原因、读回时原因被丢掉，用户看到的是"内置路径"却没有任何解释。
这正是本片要消灭的那类静默。修法：清单改由契约自身的 `FUNCTION_MODEL_EVENT_REASONS` 派生（一处定义，无法漂移），
并加一条**回归用例**：把契约里的每个原因写进去再读回来，逐个核对（修前 `call-not-attempted` 必失败）。

## 3. 真机读数（这是本片的验收）

隔离实例（`PURESCIENCE_STORAGE_ROOT=/tmp/ps-q4-root`、`dataRoot=/tmp/ps-q4/data`、端口 44192、`npm run dev:headless`），
`settings:install-codex {"source":"managed"}` 装在隔离根（303 MB，`ok:true`），建真 codex 会话
`01a0faa4-fd48-74b2-8027-be2c666fa694`（`framework=codex`、`backend=codex:builtin-codex-isolated`），
**发一次真实回合**（`acp:send-prompt`，function model 未配置）：

```
留痕（发回合前）：[]
从 send-prompt 到留痕写入：31.3s
新留痕条目：{"at":1790911512026,"functionId":"skill-selection","outcome":"built-in","reason":"bridge-unavailable"}
回读文件（磁盘上的原文）：
[ { "at": 1790911512026, "functionId": "skill-selection", "outcome": "built-in", "reason": "bridge-unavailable" } ]
```

- **判据成立**：`outcome='built-in'` 且 `reason='bridge-unavailable'`，而且**回读仍在**（磁盘原文如上）。
- 这条读数同时证明了我先前只能反推的结论：**选择器没跑的原因就是"这个回合没有技能选择桥"**——
  现在是应用自己说的，不是我从源码推的。

## 4. 与 Q3 ①④⑤ 的对照（本片收口到哪一步）

| 判据 | 状态 |
| --- | --- |
| ① 内置回落与**具名原因** | ✅ **turn 路径已取得**：`built-in` + `bridge-unavailable`（见上，磁盘原文） |
| ④ 真实往返耗时与是否真选出技能 | ⛔ **取不到，且现在能说明为什么**：桥不存在 ⇒ 没有模型往返（`elapsedMs` 只在桥存在、真的调用时才被算），也没有选择结果 |
| ⑤ 失败回落 `call-failed` | ⛔ 同上：配置的模型**根本没被咨询**（分支在咨询之前就返回了），因此 turn 路径上产生不了 `call-failed` |

⇒ 结论从"留痕为空，只能反推"变成"**应用自己写出具名原因**"。④⑤ 若要取得，需要的是**让这些 provider 形状也有桥**（路由/建桥条件是产品决定），那是独立立案，不在本片。

## 5. 门禁

`npm run typecheck`（node + web）**0 错**；`eslint`（本片 15 个文件）**0 error / 0 warning**（长行的 prettier 换行已修）；
`vitest` 5 个文件 **84 例全过**（含新增：无桥具名、空目录为"无可选项"、已选技能不写、契约原因全量回读回归）。

# A3（功能模型「立即试跑一次选择」）真机验收 —— 2026-10-01

方法：隔离实例（`PURESCIENCE_WEB_PORT=44171` + 独立 user-data-dir，**真实配置根**，`npm run build:e2e` 产物），
全部经应用自身通道（loopback RPC + web-token）。脚本 `/tmp/a3-probe-accept.py`：临时建一个指向
`http://127.0.0.1:9` 的服务、跑完删除，并把你的功能模型设置**按原样写回**（实测 `restore: {}`、
`probe provider removed: True`）。

## 三项判据（同一实例、连续三跑）

| 判据 | 结果 | 读数 |
| --- | --- | --- |
| ① 不配模型时功能仍工作，且留痕说明走的是内置路径 | ✅ | `outcome='built-in'`、`reason='not-configured'`、`elapsedMs=2`、`selected=[]`；返回的留痕最新条目就是本次（`built-in` + `not-configured`） |
| ④ 配置的模型**真的**被用上（真实往返 + 真实选择） | ✅ | `outcome='used-model'`、`model='deepseek-v4-pro'`、**`elapsedMs=5198`**、`selectedSkillIds=["expression-data-prep","科学可视化","出版级图表正确性"]`；留痕记 `used-model` + providerId + model |
| ⑤ 模型不可达时回落内置且留痕具名，调用方仍正常结束 | ✅ | `outcome='built-in'`、**`reason='call-failed'`**、`model='unreachable-model'`；留痕条目带 `reason='call-failed'` |

留痕与本次调用**同步**（每跑一次，返回的历史最新条目就是该次），不再慢一条。

## 过程中真机抓出并修掉的两个缺陷（自测发现不了）

1. **假绿：没发请求被记成"模型作答"**。第一轮 ④ 显示 `used-model` 但 `elapsedMs=1~2ms`、选中 0 项——
   真实往返不可能这么快。根因：探针的目录来自 `codexSkillCatalog(undefined)`（该构建器要求 codexHome ⇒ 必然空），
   而 `selectSkills` 在目录为空时**直接返回 [] 且根本不发请求**。修法：目录改用应用自己的 codex 技能根、
   为空时退回应用技能目录；并给 bridge 注入**记账 fetch**，一个请求都没发出就抛具名错误 ⇒ 新增原因
   `call-not-attempted`（"未发请求：没有可选项"）。新增原因被穷尽映射当场拦下（不加文案编译不过）。
2. **请求失败被记成"模型答了个空"**。第二轮 ⑤（不可达端点）仍报 `used-model`。根因是 bridge 的**设计**：
   `responses-bridge.ts:1163-1168` 把选择器的任何失败吞掉并返回 []（一个回合绝不能因选择器而断，这是对的）。
   探针继承了这个吞法就答错了问题。修法：抽成 `createProbeSkillSelection` 工厂，三态分明——
   未发请求 → `call-not-attempted`；请求被拒/非 2xx → `call-failed`；**真实应答（即使选中为空）仍算作答**。
3. 我自己写出的第三个瑕疵（同轮修）：探针把 `settings`/`events` 与探针放进 `Promise.all` 并发读 ⇒ 历史慢一条。

## 边界与不做声称

- 本证据**只覆盖探针路径**（它执行的是与回合同一个判断 `runFunctionModelSkillSelection`）。**真实 codex 回合路径**
  的取证仍待 A8 之后：本机有 Codex CLI（ChatGPT.app 包内，应用环境检查已报"已安装"），但缺 `codex-acp` 适配器
  （裸 CLI 无 `acp` 子命令），装适配器属改机器、等用户拍板。
- ④ 的 5–8 秒是**真实**往返耗时（两轮分别 8096ms / 5198ms），选择器默认预算 15s，目前未触发超时。
  这是如实读数，**不作为"已优化"**；若后续要优化，按"同语料同命令前后对比"的规矩来。

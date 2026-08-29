# PureScience 中文术语表（zh-terminology）

> 维护目的：确保全界面中文翻译术语一致、科学语境准确。新增界面文案时优先查本表；
> 术语表本身是内部规范文档，不参与运行时逻辑。
>
> 审计基线（2026-08-29，v1.4.0）：
> - 键对齐 100%（en/zh 各 1554 键，零缺漏）
> - 机翻腔扫描：无「您/你」混用、无英文句式残留、无叠词错误
> - 语义抽查 30 条全部高质量；占位符仅顺序差异（无害）

## 核心产品术语（不可随意改译）

| 英文 | 中文 | 说明/禁用译法 |
|---|---|---|
| Agent | 智能体 | 禁用「代理」（代理用于 proxy） |
| Assistant / Agent message | 智能体消息 | — |
| Session | 会话 | 禁用「对话」（对话=conversation） |
| Conversation | 对话 | 与 Session 区分 |
| Project | 项目 | — |
| Skill | 技能 | — |
| Specialist | 专才 | 市场安装的专家包；禁用「专家」（specialist vs expert 区分） |
| Connector | 连接器 | 禁用「数据源插件」 |
| Artifact | 产物 | 禁用「工件」 |
| Provenance | 溯源 | 禁用「出处」「来源证明」 |
| Transcript | 转录 | 会话消息记录 |
| Tool activity | 工具活动 | — |
| Composer | 输入区 / 编写器 | 界面语境下常用「输入区」 |
| Permission / Approval | 权限 / 审批 | 权限审批连用 |
| Permission profile | 权限配置 | — |
| Notebook | 笔记本 | 科学计算笔记本 |
| Kernel | 内核 | — |
| Memory | 记忆 | 记忆体系（分类笔记） |
| Credentials | 凭据 | 禁用「证书」 |
| Egress allowlist | 网络出口白名单 | — |
| Sandbox | 沙箱 | — |
| Marketplace | 市场 | 专才市场 |
| Update | 更新 | 版本更新 |
| Release notes | 更新说明 | — |
| CLI | 命令行 | — |
| Remote compute | 远程计算 | — |
| SSH host | SSH 主机 | — |
| Serverless GPU | Serverless GPU | 不译 |
| Model endpoint | 模型端点 | — |
| Clarification | 澄清 | agent 多问题澄清 |
| Annotation | 注解 | 选中内容进会话 |
| Context window | 上下文窗口 | — |
| Compaction | 上下文压缩 | — |
| Reasoning effort | 推理强度 | — |
| Branch | 分支 | 消息分支 |
| Review / Reviewer | 审查 / 审查者 | — |
| Plan | 计划 | 会话计划 |
| Side chat | 侧边会话 | — |
| Vision relay | 视觉中继 | — |
| Evidence | 证据 | 溯源证据 |
| Workbench | 工作台 | 产品定位词 |

## 高频操作动词

| 英文 | 中文 |
|---|---|
| Run / Execute | 运行 / 执行 |
| Save | 保存 |
| Export | 导出 |
| Import | 导入 |
| Download | 下载 |
| Install | 安装 |
| Remove / Delete | 移除 / 删除 |
| Rename | 重命名 |
| Archive | 归档 |
| Restore | 恢复 |
| Approve / Reject | 批准 / 拒绝 |
| Skip | 跳过 |
| Submit | 提交 |
| Retry | 重试 |
| Resume | 继续 |
| Cancel | 取消 |
| Attach | 附加 |
| Pin | 置顶 |

## 状态词

| 英文 | 中文 |
|---|---|
| Running | 运行中 |
| Completed | 已完成 |
| Failed | 失败 |
| Waiting for permission | 等待授权 |
| Idle | 空闲 |
| Pending | 待处理 |
| Resolved | 已解决 |
| Expired | 已过期 |
| Cancelled | 已取消 |

## 审查规则（新文案落地检查）

1. 键必须 en/zh 同步（新增键双语文案一次到位）
2. 科学术语优先本表；表外新术语需回填本表
3. 禁用词：您（一律「你」）、代理（Agent 场景）、工件、证书（凭据场景）、专家（specialist 场景）
4. 占位符 `{name}` 必须 en/zh 同名字集合（顺序可不同）
5. 技术性英文（API 名、命令、文件扩展名）保留原文

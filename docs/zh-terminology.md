# PureScience 中文术语表（zh-terminology）

> 维护目的：确保全界面中文翻译术语一致、科学语境准确。新增界面文案时优先查本表；
> 术语表本身是内部规范文档，不参与运行时逻辑。
>
> 审计基线（2026-08-29，v1.4.0）：
> - 键对齐 100%（en/zh 各 1554 键，零缺漏）
> - 机翻腔扫描：无「您/你」混用、无英文句式残留、无叠词错误
> - 语义抽查 30 条全部高质量；占位符仅顺序差异（无害）
>
> 终审（2026-10-27，v1.16.0）：Phase 3/4 新增术语已回填（目录标签/收藏、批量操作、
> 图片区域注解、MCP 服务器配置、模型网关目录、Responses API 保留原文）。
>
> **P0 复审（2026-12-07，v1.37.0）——翻译质量门禁落地**：
> - 修复 66 条未翻译键（zh 值=en 原文，含 ui.* 整片英文 46 条）→ 全部中文化
> - 术语对齐：Notebook→笔记本（值内 20 处）、tokens/Token→词元（模型计数语境 21 处，
>   认证令牌保留「令牌」）、代理→智能体（Agent 语义 80+ 处，proxy 语义 4 处保留）、
>   工件→产物（21 处）
> - 机翻腔重写 8 条（以便/该分类/是否允许/进行切换等句式）
> - **新增 CI 门禁 `src/renderer/src/i18n/translation-quality.test.ts`**（6 项断言）：
>   ① zh 值=en 值即失败（品牌/格式名白名单豁免）② 机翻腔标记词扫描 ③ 术语表强制映射
>   ④ en/zh 键完全对齐 ⑤ 无字面 `\n` 残留 ⑥ 占位符花括号成对
> - 此后任何新键漏译/术语违规都会被测试拦截，不再依赖人工轮审

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
| Model gateway | 模型网关 | 聚合多供应商的推理入口（OpenCode Zen / TokenHub） |
| Model catalog | 模型目录 | 供应商内置模型清单 |
| Favorite | 收藏 | 目录行内星标 |
| Tag | 标签 | 目录过滤标签（≤8 个/资源） |
| Batch action | 批量操作 | 技能面板批量启/禁/删 |
| Image region annotation | 图片区域注解 | 图片框选区域进会话 |
| mcpServers config | MCP 服务器配置 | 标准 MCP 客户端配置文件，`mcpServers` 保留原文 |
| Responses API | Responses API | 不译（OpenAI 原生协议名） |
| Permission mode | 权限模式 | 权限审批连用的模式选择 |
| Configuration preview | 配置预览 | 导入/导出前预览配置结构 |
| Configuration diagnostics | 配置诊断 | 配置健康检查结果 |
| Repository results | 仓库结果 | GitHub 技能仓库搜索结果 |

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

1. 键必须 en/zh 同步（新增键双语文案一次到位）——`translation-quality.test.ts` 强制
2. 科学术语优先本表；表外新术语需回填本表
3. 禁用词：您（一律「你」）、代理（Agent 场景；proxy 场景保留）、工件、证书（凭据场景；
   TLS/CA 证书包保留）、专家（specialist 场景）
4. 占位符 `{name}` 必须 en/zh 同名字集合（顺序可不同）
5. 技术性英文（API 名、命令、文件扩展名）保留原文
6. **token 按语义区分**：模型输入/输出/上下文/用量计数一律「词元」；认证凭据（API key、
   Modal token、设置令牌）用「令牌」或保留 token
7. 新增可保留英文的品牌/格式名，须同步加入测试白名单 `KEPT_IN_ENGLISH`；新增机翻腔
   标记词须加入 `MT_MARKERS`；新增术语映射须加入 `TERMINOLOGY_RULES`

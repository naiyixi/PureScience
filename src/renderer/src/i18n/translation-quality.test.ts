import { describe, expect, it } from 'vitest'

import { en } from './en'
import { zh } from './zh'

// PureScience 中文翻译质量门禁
//
// 为什么需要这道门：历史上 zh.ts 出现过 66 条值=英文原文（用户看到英文界面）、
// 机翻腔残留（以便/该分类/是否允许…）、术语混用（Notebook/笔记本、tokens/词元），
// 而人工多轮审校只修可见问题、新键一加即复发。本测试把翻译质量变成 CI 门禁：
// 任何一条违规（未翻译、机翻腔标记、术语不一致）都会让测试失败，强制下次改动时修正。
//
// 白名单原则：品牌/产品名（Claude、Codex、OpenCode、PureScience…）、技术格式名
// （PDF、CSV、JSON…）、占位符示例（example.com、my-gpu…）保留英文是正确行为，
// 不应被本测试误伤。新增保留项时请确认它真的是不可译的品牌/格式名。

const zhKeys = Object.keys(zh) as Array<keyof typeof en>

/** 值在中文界面里合法保留英文的白名单（品牌、格式名、占位示例） */
const KEPT_IN_ENGLISH = new Set<string>([
  // 品牌 / 产品名
  'Beta',
  'PureScience',
  'Claude',
  'Claude Agent',
  'Claude Code',
  'Codex',
  'OpenCode',
  'Open Science',
  'Remote.It',
  'GitHub',
  'AWS',
  'Google Cloud',
  'Azure',
  'Modal',
  'NVIDIA',
  'OpenAlex',
  'Tencent',
  'xAI',
  'Grok',
  'GLM',
  'DeepSeek',
  'Qwen',
  'Kimi',
  'CodeBuddy',
  // 技术/格式名
  'PDF',
  'CSV',
  'TSV',
  'JSON',
  'YAML',
  'SVG',
  'Python',
  'Markdown',
  'NetCDF',
  'Shell',
  'HDF5',
  'R',
  'SSE',
  'Wi-Fi',
  'Conda',
  'Notebook',
  'MCP',
  'ACP',
  'API',
  'CLI',
  'SSH',
  'OAuth',
  'SQL',
  'HTTP',
  'HTTPS',
  'WebSocket',
  'URL',
  'IPC',
  'PEM',
  'CA',
  'FFmpeg',
  'sbatch',
  'qsub',
  'bash',
  'pip',
  'conda',
  'uvx',
  'uv',
  'Rscript',
  'SKILL.md',
  'AGENTS.md',
  'mcpServers',
  'setup-token',
  // 占位符示例
  'example.com',
  'my-gpu',
  'Base URL',
  'http://127.0.0.1:8000/v1',
  'meta/llama-3.1-8b-instruct',
  'https://github.com/owner/repository',
  '/ {size} tokens',
  'tokens',
  // 保留英文的固定短语
  'uvx — Python (uv)',
  'conda.anaconda.org',
  'pypi.org',
  'NCBI',
  'EBI',
  'OurResearch',
  'Explorer',
])

/** 机翻腔标记词：出现即视为可疑，需要人工确认为自然中文表达 */
const MT_MARKERS = [
  '以便',
  '是否允许',
  '是否安装',
  '以及（',
  '进行切换',
  '应该放在哪里',
  '此操作将',
  '将会',
  '请注意',
  '请确保',
  '您',
  '该文件夹',
  '该会话',
  '该文件',
]

/** 术语表强制映射：值内出现左列即违规（应使用右列） */
const TERMINOLOGY_RULES: ReadonlyArray<readonly [string, string]> = [
  ['Notebook', '笔记本'],
  ['tokens', '词元'],
  [' token ', '词元'], // 模型计数语境（前后带空格的小写 token 残留）
  ['代理', '智能体'], // 仅当「代理」作为 Agent 语义时；proxy 语义在下方豁免
  ['工件', '产物'],
  ['来源证明', '溯源'],
  ['数据源插件', '连接器'],
  ['专家', '专才'], // specialist 语境（与 expert 区分）
]

/** 「代理」作为 proxy 语义、「证书」作为 TLS/CA 证书语义时的豁免键 */
const PROXY_KEYS = new Set<string>([
  'settings.networkProxyHint',
  'settings.egressDescription',
  'settings.egressEnabledHint',
  'settings.pemBundleHint',
  'settings.caBundlePath',
])

/** 认证令牌（credential）语境保留 token 的键 */
const CREDENTIAL_TOKEN_KEYS = new Set<string>(['settings.externalComputeModalHint'])

function isProxyContext(key: string): boolean {
  return PROXY_KEYS.has(key) || CREDENTIAL_TOKEN_KEYS.has(key) || /proxy|mirror|network|egress/i.test(key)
}

describe('zh 翻译质量门禁', () => {
  it('zh 值不等于 en 值（不允许未翻译）', () => {
    const untranslated = zhKeys.filter((key) => {
      const zhValue = zh[key]
      const enValue = en[key]
      if (zhValue === '') return false // 空串是拼接用片段（如 setupTokenSuffix），非文案
      if (zhValue === enValue) {
        return !KEPT_IN_ENGLISH.has(zhValue)
      }
      return false
    })
    expect(untranslated).toEqual([])
  })

  it('zh 值不含机翻腔标记词', () => {
    const violations = zhKeys.flatMap((key) => {
      const value = zh[key]
      const found = MT_MARKERS.filter((marker) => value.includes(marker))
      return found.map((marker) => ({ key, marker }))
    })
    expect(violations).toEqual([])
  })

  it('zh 值遵守术语表（Notebook→笔记本、tokens→词元 等）', () => {
    const violations = zhKeys.flatMap((key) => {
      const value = zh[key]
      return TERMINOLOGY_RULES.flatMap(([wrong, right]) => {
        if (!value.includes(wrong)) return []
        // 豁免语境：proxy/mirror 保留「代理」、认证令牌保留 token
        if ((wrong === '代理' || wrong === ' token ') && isProxyContext(key)) return []
        return [{ key, wrong, right }]
      })
    })
    expect(violations).toEqual([])
  })

  it('en 与 zh 键完全对齐（无缺失、无多余）', () => {
    const enKeys = Object.keys(en) as Array<keyof typeof zh>
    const zhKeySet = new Set<keyof typeof zh>(zhKeys)
    const enKeySet = new Set<keyof typeof zh>(enKeys)
    const missing = enKeys.filter((k) => !zhKeySet.has(k))
    const extra = zhKeys.filter((k) => !enKeySet.has(k))
    expect({ missing, extra }).toEqual({ missing: [], extra: [] })
  })

  it('zh 值不含字面 \\n 或多余缩进（多行字符串拼接残留）', () => {
    const violations = zhKeys.filter((key) => zh[key].includes('\\n'))
    expect(violations).toEqual([])
  })

  it('zh 值不含未闭合占位符（{name} 左右花括号成对）', () => {
    const violations = zhKeys.filter((key) => {
      const opens = (zh[key].match(/\{/g) ?? []).length
      const closes = (zh[key].match(/\}/g) ?? []).length
      return opens !== closes
    })
    expect(violations).toEqual([])
  })
})

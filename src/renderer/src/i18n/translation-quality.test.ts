import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ja } from './ja'
import { ko } from './ko'
import { ru } from './ru'
import { zh } from './zh'
import { zhHant } from './zh-Hant'

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
  'Explorer'
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
  '该文件'
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
  ['专家', '专才'] // specialist 语境（与 expert 区分）
]

/** 「代理」作为 proxy 语义、「证书」作为 TLS/CA 证书语义时的豁免键 */
const PROXY_KEYS = new Set<string>([
  'settings.networkProxyHint',
  'settings.egressDescription',
  'settings.egressEnabledHint',
  'settings.pemBundleHint',
  'settings.caBundlePath'
])

/** 认证令牌（credential）语境保留 token 的键 */
const CREDENTIAL_TOKEN_KEYS = new Set<string>(['settings.externalComputeModalHint'])

function isProxyContext(key: string): boolean {
  return (
    PROXY_KEYS.has(key) ||
    CREDENTIAL_TOKEN_KEYS.has(key) ||
    /proxy|mirror|network|egress/i.test(key)
  )
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

// 多语言扩展门禁：每个新增字典的键必须是 en 已知键的子集（缺失键运行时回退英文，因此
// 绝不引入未知键）；至少覆盖核心导航键，避免整本空字典。
const EXTRA_DICTIONARIES: ReadonlyArray<{ name: string; dict: Record<string, string> }> = [
  { name: 'zh-Hant', dict: zhHant },
  { name: 'ja', dict: ja },
  { name: 'ko', dict: ko },
  { name: 'fr', dict: fr },
  { name: 'de', dict: de },
  { name: 'es', dict: es },
  { name: 'ru', dict: ru }
]

// 每个语言都必须覆盖的最小导航/通用键集（第一屏可见的界面骨架）。
const MINIMUM_CORE_KEYS = [
  'common.save',
  'common.cancel',
  'common.close',
  'common.delete',
  'common.settings',
  'common.language',
  'settings.skills',
  'settings.connectors',
  'settings.memory',
  'settings.credentials',
  'settings.specialists',
  'settings.tags',
  'settings.compute',
  'settings.network',
  'settings.model',
  'settings.agent',
  'settings.general',
  'settings.storage',
  'settings.permissions',
  'settings.archived'
] as const

describe('多语言扩展门禁', () => {
  it.each(EXTRA_DICTIONARIES)('$name 键全部存在于 en（无未知键）', ({ dict }) => {
    const enKeySet = new Set<string>(Object.keys(en))
    const unknown = Object.keys(dict).filter((key) => !enKeySet.has(key))
    expect(unknown).toEqual([])
  })

  it.each(EXTRA_DICTIONARIES)('$name 覆盖最小核心键集', ({ dict }) => {
    const missing = MINIMUM_CORE_KEYS.filter((key) => !(key in dict))
    expect(missing).toEqual([])
  })

  it.each(EXTRA_DICTIONARIES)('$name 值不为空且与英文不同（允许品牌名白名单）', ({ dict }) => {
    const violations = Object.entries(dict).filter(([key, value]) => {
      if (value === '') return true
      if (value === en[key as keyof typeof en]) {
        return !KEPT_IN_ENGLISH.has(value) && !LATIN_COGNATES.has(value)
      }
      return false
    })
    expect(violations).toEqual([])
  })

  it.each(EXTRA_DICTIONARIES)(
    '$name 未覆盖键已在 pending-translations 登记（新增键必须翻译或显式登记，防止静默烂尾）',
    ({ name, dict }) => {
      const pending = loadPendingKeys(name)
      const enKeySet = new Set<string>(Object.keys(en))
      const missing = [...enKeySet].filter((key) => !(key in dict))
      const unregistered = missing.filter((key) => !pending.has(key))
      expect({
        unregistered,
        hint: '翻译该键到 $name，或把它加进 pending-translations/$name.pending.json（P2 翻译工程完成后应清空）'
      }).toEqual({ unregistered: [], hint: expect.any(String) })
    }
  )

  it.each(EXTRA_DICTIONARIES)(
    '$name pending-translations 无陈旧条目（已翻译的键必须从登记中移除）',
    ({ name, dict }) => {
      const pending = loadPendingKeys(name)
      const stale = [...pending].filter((key) => key in dict)
      expect({
        stale,
        hint: '这些键已经翻译，请从 pending-translations/$name.pending.json 移除，保持登记只含真实缺口'
      }).toEqual({ stale: [], hint: expect.any(String) })
    }
  )
})

// 防退化登记表：P2 全量翻译完成前，每个未翻译语言的缺口键都登记在
// src/renderer/src/i18n/pending-translations/<lang>.pending.json。新加 en 键后，要么当 PR 直接
// 翻译进所有语言，要么登记进这张表 —— 测试强制二选一，杜绝"新键只进 en/zh、其余语言逐年烂尾"。
const loadPendingKeys = (language: string): Set<string> => {
  const fileUrl = new URL(`./pending-translations/${language}.pending.json`, import.meta.url)
  const raw = readFileSync(fileUrl, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  return new Set(
    Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  )
}

// 合法的跨语言同形词：这些词在法语/德语/西班牙语等语言里本来就是同一写法（不是未翻译）。
const LATIN_COGNATES = new Set<string>([
  'Installable',
  'Total',
  'Agent',
  'Name',
  'Remote',
  '(optional)',
  'Compute',
  'Tags',
  'Runtimes',
  'General'
])

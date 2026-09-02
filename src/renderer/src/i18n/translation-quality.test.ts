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

  it.each(EXTRA_DICTIONARIES)(
    '$name 值不为空且与英文不同（允许品牌名白名单）',
    ({ name, dict }) => {
      const violations = Object.entries(dict).filter(([key, value]) => {
        if (value === '')
          return en[key as keyof typeof en] !== '' && !ALLOWED_EMPTY[name]?.includes(key)
        if (value === en[key as keyof typeof en]) {
          return !KEPT_IN_ENGLISH.has(value) && !LATIN_COGNATES.has(value)
        }
        return false
      })
      expect(violations).toEqual([])
    }
  )

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
  'General',
  // 2026-09 全量翻译后的合法同形/借词与占位符：多语言复核确认这些词在各语言中本就与英文同形
  'Marketplace',
  'Streamable HTTP',
  'Ethernet',
  'Alias',
  'Global',
  'Cache',
  'Code',
  'Format',
  'Version',
  'Navigation',
  'Notebooks',
  'Runtime',
  'Transport',
  'Tokens',
  'Variables',
  'variables',
  'Sessions',
  'Session',
  'Messages',
  'Notifications',
  'Description',
  'Source',
  'Community',
  'Details',
  'Build',
  'Log',
  'Text',
  'Live',
  'System',
  'Tools',
  'Uploads',
  'Agent:',
  'Personal',
  'Error',
  'Archive',
  'Image',
  'Type',
  'Microscope',
  'Diagnostics',
  'Arguments',
  'Instruction',
  'PHASE {number}',
  '{n} sessions',
  '{n} session',
  '{date}: {value} {metric}',
  '.',
  'h',
  'min',
  'ID (optional)',
  'R Data'
])

// 语言语法性省略：日语的属格拼接片段（Its/Their）在句内自然省略为 ∅，zh 用「其」。
const ALLOWED_EMPTY: Readonly<Record<string, readonly string[]>> = {
  ja: ['settings.its', 'settings.their']
}

// 繁体（zh-Hant）专属门禁：全量值必须为台湾惯用繁体，任何简体字残留即为违规。
// 简体→繁体高置信度对照表（仅收录严格一一对应、不会误伤繁体中同形字的常用字）。
const SIMPLIFIED_CHARS: ReadonlyArray<[string, string]> = [
  ['设', '設'],
  ['与', '與'],
  ['关', '關'],
  ['发', '發'],
  ['会', '會'],
  ['后', '後'],
  ['开', '開'],
  ['时', '時'],
  ['过', '過'],
  ['对', '對'],
  ['说', '說'],
  ['样', '樣'],
  ['见', '見'],
  ['来', '來'],
  ['个', '個'],
  ['动', '動'],
  ['产', '產'],
  ['长', '長'],
  ['们', '們'],
  ['为', '為'],
  ['现', '現'],
  ['让', '讓'],
  ['还', '還'],
  ['这', '這'],
  ['进', '進'],
  ['经', '經'],
  ['间', '間'],
  ['电', '電'],
  ['当', '當'],
  ['该', '該'],
  ['认', '認'],
  ['识', '識'],
  ['职', '職'],
  ['风', '風'],
  ['车', '車'],
  ['马', '馬'],
  ['门', '門'],
  ['问', '問'],
  ['题', '題'],
  ['体', '體'],
  ['层', '層'],
  ['应', '應'],
  ['结', '結'],
  ['号', '號'],
  ['汇', '匯'],
  ['汉', '漢'],
  ['标', '標'],
  ['红', '紅'],
  ['纸', '紙'],
  ['级', '級'],
  ['纪', '紀'],
  ['约', '約'],
  ['苏', '蘇'],
  ['艺', '藝'],
  ['节', '節'],
  ['补', '補'],
  ['评', '評'],
  ['话', '話'],
  ['词', '詞'],
  ['语', '語'],
  ['请', '請'],
  ['调', '調'],
  ['课', '課'],
  ['贝', '貝'],
  ['负', '負'],
  ['贵', '貴'],
  ['费', '費'],
  ['买', '買'],
  ['卖', '賣'],
  ['质', '質'],
  ['账', '賬'],
  ['败', '敗'],
  ['购', '購'],
  ['跃', '躍'],
  ['践', '踐'],
  ['踪', '蹤'],
  ['轮', '輪'],
  ['输', '輸'],
  ['辞', '辭'],
  ['边', '邊'],
  ['达', '達'],
  ['远', '遠'],
  ['运', '運'],
  ['适', '適'],
  ['选', '選'],
  ['视', '視'],
  ['观', '觀'],
  ['欢', '歡'],
  ['华', '華'],
  ['义', '義'],
  ['传', '傳'],
  ['优', '優'],
  ['伤', '傷'],
  ['伟', '偉'],
  ['价', '價'],
  ['众', '眾'],
  ['万', '萬'],
  ['专', '專'],
  ['业', '業'],
  ['东', '東'],
  ['丝', '絲'],
  ['丢', '丟'],
  ['两', '兩'],
  ['严', '嚴'],
  ['丧', '喪'],
  ['丰', '豐'],
  ['临', '臨'],
  ['丽', '麗'],
  ['举', '舉'],
  ['书', '書'],
  ['乱', '亂'],
  ['争', '爭'],
  ['亏', '虧'],
  ['头', '頭'],
  ['实', '實'],
  ['宝', '寶'],
  ['将', '將'],
  ['导', '導'],
  ['寿', '壽'],
  ['学', '學'],
  ['审', '審'],
  ['写', '寫'],
  ['军', '軍'],
  ['农', '農'],
  ['冲', '衝'],
  ['况', '況'],
  ['净', '淨'],
  ['减', '減'],
  ['决', '決'],
  ['机', '機'],
  ['杀', '殺'],
  ['杂', '雜'],
  ['条', '條'],
  ['极', '極'],
  ['梦', '夢'],
  ['检', '檢'],
  ['楼', '樓'],
  ['术', '術'],
  ['礼', '禮'],
  ['稳', '穩'],
  ['积', '積'],
  ['称', '稱'],
  ['种', '種'],
  ['穷', '窮'],
  ['竞', '競'],
  ['笔', '筆'],
  ['简', '簡'],
  ['类', '類'],
  ['粮', '糧'],
  ['纠', '糾'],
  ['纪', '紀'],
  ['纲', '綱'],
  ['纳', '納'],
  ['纵', '縱'],
  ['纷', '紛'],
  ['纸', '紙'],
  ['纹', '紋'],
  ['纺', '紡'],
  ['细', '細'],
  ['终', '終'],
  ['组', '組'],
  ['绍', '紹'],
  ['经', '經'],
  ['给', '給'],
  ['络', '絡'],
  ['统', '統'],
  ['继', '繼'],
  ['绩', '績'],
  ['绪', '緒'],
  ['续', '續'],
  ['绳', '繩'],
  ['维', '維'],
  ['绵', '綿'],
  ['综', '綜'],
  ['编', '編'],
  ['缓', '緩'],
  ['编', '編'],
  ['缘', '緣'],
  ['线', '線'],
  ['练', '練']
]
// 去重并转成“简体字 → 繁体字”提示
const SIMPLIFIED_LOOKUP = new Map<string, string>()
for (const [simp, trad] of SIMPLIFIED_CHARS) {
  if (!SIMPLIFIED_LOOKUP.has(simp)) SIMPLIFIED_LOOKUP.set(simp, trad)
}

describe('zh-Hant 繁体残留门禁', () => {
  it('zh-Hant 值不含简体字（全量繁体，台湾惯用）', () => {
    const violations = Object.entries(zhHant).flatMap(([key, value]) => {
      const found = [...new Set([...value].filter((ch) => SIMPLIFIED_LOOKUP.has(ch)))]
      return found.map((ch) => ({
        key,
        char: ch,
        shouldBe: SIMPLIFIED_LOOKUP.get(ch)
      }))
    })
    expect(violations).toEqual([])
  })
})

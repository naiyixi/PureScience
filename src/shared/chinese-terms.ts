// Chinese clinical term normalisation — ONE table, and every rewrite it performs is reportable.
//
// Why this exists: the evidence sources this app searches (PubMed, and every connector built on the
// same English-language contract) index Latin text. A Chinese question is therefore not a weaker
// question, it is a question the source cannot answer at all — measured against the live service on
// 2026-10-08: `term=aspirin` -> count 1, `term=阿司匹林` -> count **0** with `No items found.`.
// Sending Chinese through and reading the 0 back is the exact failure this module prevents: it would
// report "no evidence" for a body of evidence that was never queried.
//
// Three rules shape the whole file, and each one has a consumer that depends on it:
//
// 1. A query is only rewritten when EVERY Chinese run in it is accounted for by a table entry.
//    Anything left over is named, and the caller refuses by name instead of sending a query that can
//    only answer part of the question. Nothing is silently dropped — the leftovers are the message.
// 2. Every rewrite is observable. `normaliseTerm` answers "what did you change?" with the exact
//    before/after pairs, and `planChineseQuery` returns the string it actually intends to send, so a
//    reader can reproduce the query by hand. A normaliser that cannot say what it did is not auditable.
// 3. The table is a single source of truth. Each Chinese term appears once, under one canonical
//    spelling; alternative spellings are `variants`, never a second row. A second table for the same
//    terms is a second vocabulary that drifts, and the drift is invisible until a query stops matching.
//
// The English term of record is deliberately the everyday term (`aspirin`, `lung cancer`) rather than a
// MeSH descriptor: the sources apply their own automatic term mapping on top, and pre-mapping to a
// descriptor here would freeze one edition of a controlled vocabulary into this file.
//
// Terminology is not localisation. This table is data the science tools read, so it stays out of the
// i18n dictionaries and its identifiers are English, like every other shared module.

import { hasCjkScript } from './citation/names'

export const CHINESE_TERM_KINDS = [
  'drug',
  'indication',
  'institution',
  'journal',
  'connective'
] as const

export type ChineseTermKind = (typeof CHINESE_TERM_KINDS)[number]

/** A term that denotes something — the four categories a Chinese clinical query is built from. */
export type ChineseDenotingKind = Exclude<ChineseTermKind, 'connective'>

/**
 * One row of the table.
 *
 * `canonical` is the spelling of record in Chinese (what a report should print). `variants` are the
 * other spellings seen in Chinese literature and in the app's own inputs, the ones that must resolve to
 * the same row. `english` is what actually goes on the wire, and is absent only for connectives —
 * Chinese function words that carry no searchable content in an AND-chained query.
 */
export type ChineseTermEntry = {
  canonical: string
  kind: ChineseDenotingKind
  variants?: readonly string[]
  english: string
}

export type ChineseConnectiveEntry = {
  canonical: string
  kind: 'connective'
  variants?: readonly string[]
}

export type ChineseTableEntry = ChineseTermEntry | ChineseConnectiveEntry

const entry = (
  canonical: string,
  kind: ChineseDenotingKind,
  english: string,
  variants: readonly string[] = []
): ChineseTermEntry => ({ canonical, kind, english, ...(variants.length ? { variants } : {}) })

// A variant must contain a Han character, because this table normalises Chinese input: a spelling with
// no Han character in it (a bare acronym like "NMPA") would never reach the matcher, and an entry no
// query can reach is coverage on paper only. The acronym is what a term normalises TO, not FROM. The
// read-source test asserts exactly this reachability property rather than a character class, so
// "301医院" and "II型糖尿病" stay legal while a pure-Latin spelling does not.

const connective = (
  canonical: string,
  variants: readonly string[] = []
): ChineseConnectiveEntry => ({
  canonical,
  kind: 'connective',
  ...(variants.length ? { variants } : {})
})

// ---------------------------------------------------------------------------------------------
// The table. Grouped by kind for review; order inside a group carries no meaning (matching is
// longest-key-first, never first-in-file).
// ---------------------------------------------------------------------------------------------

const DRUGS: readonly ChineseTermEntry[] = [
  entry('阿司匹林', 'drug', 'aspirin', ['乙酰水杨酸']),
  entry('氯吡格雷', 'drug', 'clopidogrel'),
  entry('替格瑞洛', 'drug', 'ticagrelor'),
  entry('华法林', 'drug', 'warfarin'),
  entry('利伐沙班', 'drug', 'rivaroxaban'),
  entry('达比加群', 'drug', 'dabigatran', ['达比加群酯']),
  entry('肝素', 'drug', 'heparin'),
  entry('低分子肝素', 'drug', 'low molecular weight heparin'),
  entry('阿托伐他汀', 'drug', 'atorvastatin'),
  entry('瑞舒伐他汀', 'drug', 'rosuvastatin'),
  entry('辛伐他汀', 'drug', 'simvastatin'),
  entry('依折麦布', 'drug', 'ezetimibe'),
  entry('二甲双胍', 'drug', 'metformin', ['盐酸二甲双胍']),
  entry('阿卡波糖', 'drug', 'acarbose'),
  entry('格列美脲', 'drug', 'glimepiride'),
  entry('西格列汀', 'drug', 'sitagliptin'),
  entry('达格列净', 'drug', 'dapagliflozin'),
  entry('恩格列净', 'drug', 'empagliflozin'),
  entry('利拉鲁肽', 'drug', 'liraglutide'),
  entry('司美格鲁肽', 'drug', 'semaglutide', ['索马鲁肽']),
  entry('胰岛素', 'drug', 'insulin'),
  entry('氨氯地平', 'drug', 'amlodipine'),
  entry('硝苯地平', 'drug', 'nifedipine'),
  entry('缬沙坦', 'drug', 'valsartan'),
  entry('氯沙坦', 'drug', 'losartan'),
  entry('依那普利', 'drug', 'enalapril'),
  entry('培哚普利', 'drug', 'perindopril'),
  entry('美托洛尔', 'drug', 'metoprolol'),
  entry('比索洛尔', 'drug', 'bisoprolol'),
  entry('氢氯噻嗪', 'drug', 'hydrochlorothiazide'),
  entry('呋塞米', 'drug', 'furosemide', ['速尿']),
  entry('螺内酯', 'drug', 'spironolactone'),
  entry('硝酸甘油', 'drug', 'nitroglycerin'),
  entry('地高辛', 'drug', 'digoxin'),
  entry('胺碘酮', 'drug', 'amiodarone'),
  entry('奥美拉唑', 'drug', 'omeprazole'),
  entry('泮托拉唑', 'drug', 'pantoprazole'),
  entry('布洛芬', 'drug', 'ibuprofen'),
  entry('对乙酰氨基酚', 'drug', 'acetaminophen', ['扑热息痛', '醋氨酚']),
  entry('塞来昔布', 'drug', 'celecoxib'),
  entry('泼尼松', 'drug', 'prednisone'),
  entry('泼尼松龙', 'drug', 'prednisolone'),
  entry('地塞米松', 'drug', 'dexamethasone'),
  entry('甲泼尼龙', 'drug', 'methylprednisolone'),
  entry('环孢素', 'drug', 'cyclosporine'),
  entry('他克莫司', 'drug', 'tacrolimus'),
  entry('甲氨蝶呤', 'drug', 'methotrexate'),
  entry('来氟米特', 'drug', 'leflunomide'),
  entry('羟氯喹', 'drug', 'hydroxychloroquine'),
  entry('阿莫西林', 'drug', 'amoxicillin'),
  entry('头孢曲松', 'drug', 'ceftriaxone'),
  entry('阿奇霉素', 'drug', 'azithromycin'),
  entry('克拉霉素', 'drug', 'clarithromycin'),
  entry('左氧氟沙星', 'drug', 'levofloxacin'),
  entry('莫西沙星', 'drug', 'moxifloxacin'),
  entry('万古霉素', 'drug', 'vancomycin'),
  entry('甲硝唑', 'drug', 'metronidazole'),
  entry('氟康唑', 'drug', 'fluconazole'),
  entry('阿昔洛韦', 'drug', 'acyclovir'),
  entry('奥司他韦', 'drug', 'oseltamivir'),
  entry('沙丁胺醇', 'drug', 'albuterol', ['舒喘灵']),
  entry('孟鲁司特', 'drug', 'montelukast'),
  entry('布地奈德', 'drug', 'budesonide'),
  entry('别嘌醇', 'drug', 'allopurinol'),
  entry('秋水仙碱', 'drug', 'colchicine'),
  entry('非布司他', 'drug', 'febuxostat'),
  entry('阿仑膦酸钠', 'drug', 'alendronate'),
  entry('左甲状腺素', 'drug', 'levothyroxine', ['左旋甲状腺素']),
  entry('甲巯咪唑', 'drug', 'methimazole', ['他巴唑']),
  entry('促红细胞生成素', 'drug', 'erythropoietin', ['促红素']),
  entry('曲妥珠单抗', 'drug', 'trastuzumab'),
  entry('贝伐珠单抗', 'drug', 'bevacizumab'),
  entry('利妥昔单抗', 'drug', 'rituximab'),
  entry('帕博利珠单抗', 'drug', 'pembrolizumab'),
  entry('纳武利尤单抗', 'drug', 'nivolumab'),
  entry('伊马替尼', 'drug', 'imatinib'),
  entry('吉非替尼', 'drug', 'gefitinib'),
  entry('厄洛替尼', 'drug', 'erlotinib'),
  entry('奥希替尼', 'drug', 'osimertinib'),
  entry('顺铂', 'drug', 'cisplatin'),
  entry('卡铂', 'drug', 'carboplatin'),
  entry('紫杉醇', 'drug', 'paclitaxel'),
  entry('多西他赛', 'drug', 'docetaxel'),
  entry('氟尿嘧啶', 'drug', 'fluorouracil'),
  entry('环磷酰胺', 'drug', 'cyclophosphamide'),
  entry('多柔比星', 'drug', 'doxorubicin', ['阿霉素']),
  entry('长春新碱', 'drug', 'vincristine')
]

const INDICATIONS: readonly ChineseTermEntry[] = [
  entry('高血压', 'indication', 'hypertension', ['高血压病']),
  entry('糖尿病', 'indication', 'diabetes mellitus'),
  entry('2型糖尿病', 'indication', 'type 2 diabetes mellitus', ['二型糖尿病', 'II型糖尿病']),
  entry('1型糖尿病', 'indication', 'type 1 diabetes mellitus', ['一型糖尿病', 'I型糖尿病']),
  entry('糖尿病肾病', 'indication', 'diabetic nephropathy'),
  entry('糖尿病视网膜病变', 'indication', 'diabetic retinopathy'),
  entry('冠心病', 'indication', 'coronary artery disease', ['冠状动脉粥样硬化性心脏病']),
  entry('心肌梗死', 'indication', 'myocardial infarction', ['心梗', '急性心肌梗死']),
  entry('心绞痛', 'indication', 'angina pectoris'),
  entry('心力衰竭', 'indication', 'heart failure', ['心衰']),
  entry('心房颤动', 'indication', 'atrial fibrillation', ['房颤']),
  entry('脑卒中', 'indication', 'stroke', ['中风', '脑梗死', '缺血性脑卒中']),
  entry('脑出血', 'indication', 'cerebral hemorrhage'),
  entry('短暂性脑缺血发作', 'indication', 'transient ischemic attack'),
  entry('慢性阻塞性肺疾病', 'indication', 'chronic obstructive pulmonary disease', ['慢阻肺']),
  entry('哮喘', 'indication', 'asthma', ['支气管哮喘']),
  entry('肺癌', 'indication', 'lung cancer'),
  entry('非小细胞肺癌', 'indication', 'non-small cell lung cancer'),
  entry('小细胞肺癌', 'indication', 'small cell lung cancer'),
  entry('乳腺癌', 'indication', 'breast cancer'),
  entry('结直肠癌', 'indication', 'colorectal cancer', ['大肠癌', '结肠癌', '直肠癌']),
  entry('胃癌', 'indication', 'gastric cancer'),
  entry('肝癌', 'indication', 'liver cancer'),
  entry('肝细胞癌', 'indication', 'hepatocellular carcinoma'),
  entry('食管癌', 'indication', 'esophageal cancer'),
  entry('胰腺癌', 'indication', 'pancreatic cancer'),
  entry('前列腺癌', 'indication', 'prostate cancer'),
  entry('甲状腺癌', 'indication', 'thyroid cancer'),
  entry('白血病', 'indication', 'leukemia'),
  entry('急性髓系白血病', 'indication', 'acute myeloid leukemia', ['急性髓性白血病']),
  entry('淋巴瘤', 'indication', 'lymphoma'),
  entry('多发性骨髓瘤', 'indication', 'multiple myeloma'),
  entry('阿尔茨海默病', 'indication', 'Alzheimer disease', [
    '阿尔茨海默症',
    '老年痴呆',
    '老年性痴呆'
  ]),
  entry('帕金森病', 'indication', 'Parkinson disease', ['帕金森氏病']),
  entry('抑郁症', 'indication', 'depression'),
  entry('焦虑症', 'indication', 'anxiety disorders', ['焦虑障碍']),
  entry('精神分裂症', 'indication', 'schizophrenia'),
  entry('癫痫', 'indication', 'epilepsy'),
  entry('偏头痛', 'indication', 'migraine'),
  entry('慢性肾脏病', 'indication', 'chronic kidney disease', ['慢性肾病']),
  entry('急性肾损伤', 'indication', 'acute kidney injury', ['急性肾衰竭']),
  entry('肾病综合征', 'indication', 'nephrotic syndrome'),
  entry('高脂血症', 'indication', 'hyperlipidemia', ['血脂异常']),
  entry('动脉粥样硬化', 'indication', 'atherosclerosis'),
  entry('静脉血栓栓塞', 'indication', 'venous thromboembolism'),
  entry('肺栓塞', 'indication', 'pulmonary embolism'),
  entry('深静脉血栓形成', 'indication', 'deep vein thrombosis', ['深静脉血栓']),
  entry('贫血', 'indication', 'anemia'),
  entry('缺铁性贫血', 'indication', 'iron deficiency anemia'),
  entry('脓毒症', 'indication', 'sepsis', ['败血症']),
  entry('感染性休克', 'indication', 'septic shock'),
  entry('肺炎', 'indication', 'pneumonia'),
  entry('结核病', 'indication', 'tuberculosis'),
  entry('肺结核', 'indication', 'pulmonary tuberculosis'),
  entry('乙型肝炎', 'indication', 'hepatitis B', ['乙肝']),
  entry('丙型肝炎', 'indication', 'hepatitis C', ['丙肝']),
  entry('肝硬化', 'indication', 'liver cirrhosis'),
  entry('胃食管反流病', 'indication', 'gastroesophageal reflux disease'),
  entry('消化性溃疡', 'indication', 'peptic ulcer'),
  entry('幽门螺杆菌感染', 'indication', 'Helicobacter pylori infection', ['幽门螺杆菌']),
  entry('炎症性肠病', 'indication', 'inflammatory bowel disease'),
  entry('克罗恩病', 'indication', 'Crohn disease'),
  entry('溃疡性结肠炎', 'indication', 'ulcerative colitis'),
  entry('类风湿关节炎', 'indication', 'rheumatoid arthritis'),
  entry('系统性红斑狼疮', 'indication', 'systemic lupus erythematosus', ['红斑狼疮']),
  entry('强直性脊柱炎', 'indication', 'ankylosing spondylitis'),
  entry('银屑病', 'indication', 'psoriasis', ['牛皮癣']),
  entry('骨质疏松', 'indication', 'osteoporosis', ['骨质疏松症']),
  entry('痛风', 'indication', 'gout'),
  entry('甲状腺功能减退', 'indication', 'hypothyroidism', ['甲减']),
  entry('甲状腺功能亢进', 'indication', 'hyperthyroidism', ['甲亢']),
  entry('肥胖症', 'indication', 'obesity', ['肥胖']),
  entry('代谢综合征', 'indication', 'metabolic syndrome'),
  entry('睡眠呼吸暂停', 'indication', 'sleep apnea', ['阻塞性睡眠呼吸暂停']),
  entry('新型冠状病毒感染', 'indication', 'COVID-19', ['新型冠状病毒肺炎', '新冠肺炎', '新冠']),
  entry('流感', 'indication', 'influenza', ['流行性感冒']),
  entry('艾滋病', 'indication', 'HIV infections', ['获得性免疫缺陷综合征']),
  entry('白内障', 'indication', 'cataract'),
  entry('青光眼', 'indication', 'glaucoma'),
  entry('年龄相关性黄斑变性', 'indication', 'macular degeneration'),
  entry('良性前列腺增生', 'indication', 'prostatic hyperplasia'),
  entry('慢性疼痛', 'indication', 'chronic pain'),
  entry('急性呼吸窘迫综合征', 'indication', 'acute respiratory distress syndrome'),
  entry('肺动脉高压', 'indication', 'pulmonary hypertension'),
  entry('主动脉夹层', 'indication', 'aortic dissection'),
  entry('川崎病', 'indication', 'Kawasaki disease'),
  entry('手足口病', 'indication', 'hand, foot and mouth disease')
]

const INSTITUTIONS: readonly ChineseTermEntry[] = [
  entry('国家药品监督管理局', 'institution', 'National Medical Products Administration', [
    '国家药监局'
  ]),
  entry(
    '国家卫生健康委员会',
    'institution',
    'National Health Commission of the People’s Republic of China',
    ['国家卫健委']
  ),
  entry(
    '国家疾病预防控制局',
    'institution',
    'National Disease Control and Prevention Administration'
  ),
  entry(
    '中国疾病预防控制中心',
    'institution',
    'Chinese Center for Disease Control and Prevention',
    ['中国疾控中心']
  ),
  entry('中华医学会', 'institution', 'Chinese Medical Association'),
  entry('中国医师协会', 'institution', 'Chinese Medical Doctor Association'),
  entry('国家医疗保障局', 'institution', 'National Healthcare Security Administration', [
    '国家医保局'
  ]),
  entry(
    '国家中医药管理局',
    'institution',
    'National Administration of Traditional Chinese Medicine'
  ),
  entry('中国食品药品检定研究院', 'institution', 'National Institutes for Food and Drug Control', [
    '中检院'
  ]),
  entry('中国临床试验注册中心', 'institution', 'Chinese Clinical Trial Registry'),
  entry('国家癌症中心', 'institution', 'National Cancer Center of China'),
  entry('北京协和医院', 'institution', 'Peking Union Medical College Hospital'),
  entry('四川大学华西医院', 'institution', 'West China Hospital, Sichuan University'),
  entry('复旦大学附属中山医院', 'institution', 'Zhongshan Hospital, Fudan University'),
  entry(
    '中国人民解放军总医院',
    'institution',
    'Chinese People’s Liberation Army General Hospital',
    ['301医院']
  )
]

const JOURNALS: readonly ChineseTermEntry[] = [
  entry('中华医学杂志', 'journal', 'National Medical Journal of China'),
  entry('中华内科杂志', 'journal', 'Chinese Journal of Internal Medicine'),
  entry('中华外科杂志', 'journal', 'Chinese Journal of Surgery'),
  entry('中华心血管病杂志', 'journal', 'Chinese Journal of Cardiology'),
  entry('中华肿瘤杂志', 'journal', 'Chinese Journal of Oncology'),
  entry('中华流行病学杂志', 'journal', 'Chinese Journal of Epidemiology'),
  entry(
    '中华结核和呼吸杂志',
    'journal',
    'Chinese Journal of Tuberculosis and Respiratory Diseases'
  ),
  entry('中华儿科杂志', 'journal', 'Chinese Journal of Pediatrics'),
  entry('中华神经科杂志', 'journal', 'Chinese Journal of Neurology'),
  entry('中华预防医学杂志', 'journal', 'Chinese Journal of Preventive Medicine'),
  entry('中国循证医学杂志', 'journal', 'Chinese Journal of Evidence-Based Medicine'),
  entry('中国新药杂志', 'journal', 'Chinese Journal of New Drugs'),
  entry('中国临床药理学杂志', 'journal', 'Chinese Journal of Clinical Pharmacology'),
  entry('柳叶刀', 'journal', 'Lancet'),
  entry('新英格兰医学杂志', 'journal', 'New England Journal of Medicine'),
  entry('美国医学会杂志', 'journal', 'JAMA'),
  entry('英国医学杂志', 'journal', 'BMJ')
]

// Chinese function words. They carry no searchable content in an AND-chained query, so a fully
// matched run that leaves one behind still counts as accounted for. Keeping them in the table (rather
// than special-casing single characters in the matcher) means they are reviewed and tested like every
// other row — and, because an unmatched leftover is REFUSED rather than dropped, a particle entry can
// never silently eat a character of a term the table does not know.
const CONNECTIVES: readonly ChineseConnectiveEntry[] = [
  connective('的'),
  connective('与', ['和', '及']),
  connective('对'),
  connective('在'),
  connective('用于'),
  connective('治疗', ['疗法']),
  connective('联合'),
  connective('疗效'),
  connective('患者', ['病人']),
  connective('有无', ['是否']),
  connective('比较', ['对比'])
]

export const CHINESE_TERMS: readonly ChineseTableEntry[] = Object.freeze([
  ...DRUGS,
  ...INDICATIONS,
  ...INSTITUTIONS,
  ...JOURNALS,
  ...CONNECTIVES
])

// ---------------------------------------------------------------------------------------------
// Matching. Built once from the table above; every key (canonical and variant) maps back to its row.
// ---------------------------------------------------------------------------------------------

type KeyIndex = {
  /** Longest key first, so 非小细胞肺癌 wins over 肺癌 and 中风 over a particle that also matches. */
  keys: readonly string[]
  byKey: ReadonlyMap<string, { entry: ChineseTableEntry; key: string }>
}

const buildIndex = (): KeyIndex => {
  const byKey = new Map<string, { entry: ChineseTableEntry; key: string }>()
  for (const row of CHINESE_TERMS) {
    for (const key of [row.canonical, ...(row.variants ?? [])]) {
      const existing = byKey.get(key)
      if (existing) {
        // A key that resolves to two rows is not a table, it is a coin toss. Refuse at build time so
        // the module cannot ship ambiguous data — the source-read test asserts this is never hit.
        throw new Error(
          `chinese-terms: "${key}" is listed by both "${existing.entry.canonical}" and "${row.canonical}"`
        )
      }
      byKey.set(key, { entry: row, key })
    }
  }
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b))
  return { keys, byKey }
}

const INDEX = buildIndex()

// Chinese sentence punctuation is not a term: it separates terms. Replaced with a space so the two
// halves of "阿司匹林，高血压" stay two matches instead of one unknown run.
const CJK_PUNCTUATION_RE = /[，。；：、！？（）《》【】“”‘’…·—～／]/g
// A run of Han characters with nothing between them: the unit a matcher has to fully account for.
const HAN_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

const hanRuns = (text: string): string[] => text.match(HAN_RUN) ?? []

export const normaliseQueryPunctuation = (text: string): string =>
  text.replace(CJK_PUNCTUATION_RE, ' ').replace(/\s+/g, ' ').trim()

export const CHINESE_TERM_REFUSALS = [
  // Nothing to normalise: the caller passed an empty string.
  'empty',
  // No Han characters at all — the query is already in the language the sources index.
  'no-chinese-terms',
  // A term is not in the table, so no rewrite of it is defined.
  'unknown-term'
] as const

export type ChineseTermRefusal = (typeof CHINESE_TERM_REFUSALS)[number]

/** One rewrite, in the direction it happened: this input substring became that output substring. */
export type TermSubstitution = {
  from: string
  /** The canonical spelling, or the empty string for a function word removed from the query. */
  to: string
  entry: ChineseTableEntry
}

export type ChineseTermMatch = {
  ok: true
  /** Exactly what the caller passed. */
  raw: string
  /** The canonical Chinese spelling this input resolves to. */
  canonical: string
  kind: ChineseDenotingKind
  /** What goes on the wire. */
  english: string
  /** Empty when the input was already canonical — so "nothing was replaced" is distinguishable from "unknown". */
  substitutions: readonly TermSubstitution[]
}

export type ChineseTermRefusalResult = {
  ok: false
  raw: string
  reason: ChineseTermRefusal
  /** A sentence the caller can show as-is. Never a stack. */
  detail: string
}

export type ChineseTermNormalisation = ChineseTermMatch | ChineseTermRefusalResult

/**
 * Resolve ONE Chinese term to its row.
 *
 * Deliberately single-term: a caller that has a term (a column of a table, a user's selection) wants to
 * know what that term is called, not to have a sentence rewritten under it. Whole queries go through
 * `planChineseQuery`.
 */
export const normaliseTerm = (raw: unknown): ChineseTermNormalisation => {
  const text = String(raw ?? '').trim()
  if (!text) {
    return { ok: false, raw: text, reason: 'empty', detail: 'No term was given to normalise.' }
  }
  if (!hasCjkScript(text)) {
    return {
      ok: false,
      raw: text,
      reason: 'no-chinese-terms',
      detail: `"${text}" has no Chinese characters, so there is nothing to normalise.`
    }
  }
  const hit = INDEX.byKey.get(text)
  if (!hit) {
    return {
      ok: false,
      raw: text,
      reason: 'unknown-term',
      detail: `"${text}" is not in the Chinese term table (${CHINESE_TERMS.length} entries), so no accepted spelling of it is known.`
    }
  }
  const row = hit.entry
  if (row.kind === 'connective') {
    return {
      ok: false,
      raw: text,
      reason: 'unknown-term',
      detail: `"${text}" is a Chinese function word, not a term: it is removed from a query rather than resolved to one.`
    }
  }
  const substitutions: TermSubstitution[] =
    hit.key === row.canonical ? [] : [{ from: hit.key, to: row.canonical, entry: row }]
  return {
    ok: true,
    raw: text,
    canonical: row.canonical,
    kind: row.kind,
    english: row.english,
    substitutions
  }
}

export type ChineseQueryPlan = {
  /** True when the input contained at least one Han character. */
  cjk: boolean
  /** Every table term found, longest match first. */
  applied: readonly TermSubstitution[]
  /**
   * The query to send: matched terms replaced by their English term of record, function words removed.
   * What happens to Chinese the table does not account for depends on the policy the caller asked for —
   * under the default (`refuse`) it is removed as well, so this is the *mapped* question only, which is
   * why it may be sent on one condition alone (see `unmapped`); under `keep` it stays exactly as typed.
   */
  query: string
  /**
   * Chinese text the table does not account for. Non-empty means the question cannot be asked: the
   * caller refuses by name (naming these) rather than sending `query`, which answers only the part of
   * the question that happened to be in the table.
   */
  unmapped: readonly string[]
}

/**
 * Plan the rewrite of a whole query: which terms resolve, what string would be sent, and what the table
 * could not account for.
 *
 * Pure and total — it never throws and never sends anything. The decision to refuse is the caller's, but
 * the plan makes that decision mechanical: `unmapped.length > 0` means the query cannot be mapped.
 */
/**
 * How a caller wants Chinese the table cannot map to be treated.
 *
 * Two sources in this app answer Chinese differently, so this is a named choice with a measured reason
 * rather than a habit:
 *
 * - `'refuse'` (default): `query` carries the mapped part only. A caller that refuses by name when
 *   `unmapped` is non-empty must use this — sending `query` would answer a fraction of the question and
 *   let the result pass for an answer to all of it. (PubMed indexes Latin text: `term=阿司匹林` returns
 *   zero matches whether or not the evidence exists.)
 * - `'keep'`: `query` keeps the unaccounted-for Chinese exactly as typed. For a source that indexes
 *   Chinese and answers it — measured per source, never assumed — dropping it would remove a search
 *   that works; the caller reports `unmapped` alongside the result so a thin answer stays readable as
 *   thin rather than as absent evidence.
 */
export type ChineseUnmappedPolicy = 'refuse' | 'keep'

export const planChineseQuery = (
  raw: unknown,
  options: { unmapped?: ChineseUnmappedPolicy } = {}
): ChineseQueryPlan => {
  const policy = options.unmapped ?? 'refuse'
  const text = String(raw ?? '')
  if (!hasCjkScript(text)) {
    return { cjk: false, applied: [], query: normaliseQueryPunctuation(text), unmapped: [] }
  }

  const source = normaliseQueryPunctuation(text)
  const applied: TermSubstitution[] = []
  const pieces: string[] = []
  const gaps: string[] = []
  let cursor = 0
  let plain = ''

  const flushPlain = (): void => {
    if (!plain) return
    gaps.push(plain)
    // Under `refuse` (the default) Chinese the table does not know is not part of the mapped question:
    // it is named in `unmapped` and kept out of `query`, so `query` can never pass for the whole
    // question. Under `keep` it stays, because the caller has established that its source answers it.
    pieces.push(policy === 'keep' ? plain : plain.replace(HAN_RUN, ' '))
    plain = ''
  }

  while (cursor < source.length) {
    let matched: { entry: ChineseTableEntry; key: string } | undefined
    for (const key of INDEX.keys) {
      if (key.length <= source.length - cursor && source.startsWith(key, cursor)) {
        matched = INDEX.byKey.get(key)
        break
      }
    }
    if (!matched) {
      plain += source[cursor]
      cursor += 1
      continue
    }
    const { entry: row, key } = matched
    flushPlain()
    if (row.kind === 'connective') {
      applied.push({ from: key, to: '', entry: row })
    } else {
      applied.push({ from: key, to: row.canonical, entry: row })
      pieces.push(row.english)
    }
    cursor += key.length
  }
  flushPlain()

  // Whatever Han text survived the match is the table's gap. Reported verbatim (per run, not per
  // character) so the message names words rather than letters.
  const unmapped: string[] = []
  for (const gap of gaps) {
    for (const run of hanRuns(gap)) unmapped.push(run)
  }

  return {
    cjk: true,
    applied,
    query: pieces.join(' ').replace(/\s+/g, ' ').trim(),
    unmapped
  }
}

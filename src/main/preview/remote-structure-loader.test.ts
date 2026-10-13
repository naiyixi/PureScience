import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EGRESS_DOMAIN_GROUPS, type EgressSettings } from '../../shared/egress'
import { engineForPredictionPath } from '../../shared/structure-artifact-facts'
import {
  STRUCTURE_REMOTE_MAX_BYTES,
  structureRemoteFileName,
  structureRemoteUrl
} from '../../shared/structure-remote-source'
import {
  createRemoteStructureLoader,
  type RemoteStructureLoaderDeps
} from './remote-structure-loader'

// 白名单命中（并且系统强制）：os-sandbox + 白名单里显式列了这台主机 ⇒ 直接允许、不问卡。
// 注意 `groups: {}` 是**默认开**（`settings.groups[id] !== false` ⇒ 开），所以这里不用改组：
// customDomains 里那一条足够命中，而内置组本来就把 rcsb 这类科研站点算在内。
const allowedEgress = (): EgressSettings => ({
  enabled: true,
  groups: {},
  customDomains: ['files.rcsb.org']
})

// 「一条都不许」必须**逐组显式关掉**：`groups: {}` 不等于「什么都不允许」，它等于「全开」。
const closedEveryGroupBut = (domain: string): EgressSettings => ({
  enabled: true,
  groups: Object.fromEntries(EGRESS_DOMAIN_GROUPS.map((group) => [group.id, false])),
  customDomains: [domain]
})

describe('远程结构加载（主进程）', () => {
  let root = ''
  const loaded = 'HEADER    REMOTE STRUCTURE\nATOM      1  CA  ALA A   1\n'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'purescience-remote-structure-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const harness = (
    overrides: Partial<RemoteStructureLoaderDeps> = {}
  ): {
    loader: ReturnType<typeof createRemoteStructureLoader>
    deps: RemoteStructureLoaderDeps
  } => {
    const deps: RemoteStructureLoaderDeps = {
      egressSettings: () => allowedEgress(),
      protection: () => 'os-sandbox',
      workspaceFor: () => root,
      fetchText: vi.fn().mockResolvedValue({ ok: true, text: loaded }),
      ...overrides
    }
    return { loader: createRemoteStructureLoader(deps), deps }
  }

  it('id 不合法的当口就拒：不问卡、也不出网', async () => {
    const approvals = { request: vi.fn().mockResolvedValue('once') }
    const { loader, deps } = harness({ approvals, egressSettings: () => undefined })

    const result = await loader.load({ sessionId: 'session-1', id: 'nope' })

    expect(result).toEqual({
      ok: false,
      reason: 'invalid-id',
      detail: expect.stringContaining('4 位 PDB id')
    })
    expect(approvals.request).not.toHaveBeenCalled()
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('白名单未命中 ⇒ 拒，且一次网络都不发', async () => {
    const { loader, deps } = harness({
      egressSettings: () => closedEveryGroupBut('example.org')
    })

    const result = await loader.load({ sessionId: 'session-1', id: '1CRN' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('not-allowlisted')
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('白名单命中且系统强制 ⇒ 直接取回，不问卡', async () => {
    const approvals = { request: vi.fn() }
    const { loader, deps } = harness({ approvals })

    const result = await loader.load({ sessionId: 'session-1', id: '1crn' })

    expect(approvals.request).not.toHaveBeenCalled()
    expect(deps.fetchText).toHaveBeenCalledWith(structureRemoteUrl('1CRN'))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a load')
    expect(result.id).toBe('1CRN')
    expect(result.fileName).toBe(structureRemoteFileName('1CRN'))
    expect(result.path).toBe(join(root, structureRemoteFileName('1CRN')))
    await expect(readFile(result.path, 'utf8')).resolves.toBe(loaded)
  })

  it('闸门关着（白名单不限制）⇒ 必须有人点头，没有人能点头就拒', async () => {
    const { loader, deps } = harness({
      egressSettings: () => ({ enabled: false, groups: {}, customDomains: [] }),
      approvals: undefined
    })

    const result = await loader.load({ sessionId: 'session-1', id: '1CRN' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('approval-denied')
    // 「问不到」不等于「可以」：一次网络都没发。
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('用户在看板上拒绝 ⇒ 拒且不落盘；卡面拿到的是**应用动作**那一段', async () => {
    const approvals = { request: vi.fn().mockResolvedValue('deny') }
    const { loader, deps } = harness({
      egressSettings: () => undefined,
      protection: () => 'unprotected',
      approvals
    })

    const result = await loader.load({ sessionId: 'session-1', id: '1CRN' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toBe('approval-denied')
    expect(deps.fetchText).not.toHaveBeenCalled()
    expect(approvals.request.mock.calls[0]?.[0]).toMatchObject({
      connector: 'structure-view',
      method: 'load-remote-structure',
      availableScopes: ['once'],
      appAction: {
        surface: 'structure-view',
        action: 'load-remote-structure',
        writes: [{ kind: 'structure-file', fileName: '1CRN.pdb', extension: 'pdb' }]
      }
    })
  })

  it('不认识来源 ⇒ 具名拒绝，且**不回落**到 PDB（不回一次网）', async () => {
    const { loader, deps } = harness()
    const result = await loader.load({
      sessionId: 'session-1',
      id: '1CRN',
      source: 'made-up' as never
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('unknown-source')
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('预测来源落进 predictions/<engineId>/，视图侧事实条正靠这条认出引擎（写读同一条约定）', async () => {
    const { loader, deps } = harness({
      egressSettings: () => ({
        enabled: true,
        groups: {},
        customDomains: ['alphafold.ebi.ac.uk']
      })
    })
    const result = await loader.load({
      sessionId: 'session-1',
      id: 'p00533',
      source: 'alphafold-db'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // 身份规范化成大写、**不截断**；文件名与落点都来自登记表。
    expect(result.id).toBe('P00533')
    expect(result.source).toBe('alphafold-db')
    expect(result.host).toBe('alphafold.ebi.ac.uk')
    expect(result.fileName).toBe('AF-P00533-F1-model_v6.pdb')
    expect(
      result.path.endsWith(join('predictions', 'alphafold-db', 'AF-P00533-F1-model_v6.pdb'))
    ).toBe(true)
    // **这一条才是打通**：视图侧按路径解析出的引擎，正是这份产物的来源。
    expect(engineForPredictionPath(result.path)?.id).toBe('alphafold-db')
    expect(deps.fetchText).toHaveBeenCalledWith(
      'https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb'
    )
  })

  it('实验来源（PDB）落工作区根 ⇒ 视图侧**不**给它预测事实（实验不能被说成预测）', async () => {
    const { loader } = harness()
    const result = await loader.load({ sessionId: 'session-1', id: '1CRN' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source).toBe('pdb')
    // 实验类落**工作区根**（夹具的工作区就是那个临时目录），没有 predictions 那一层。
    expect(result.path).toBe(join(root, '1CRN.pdb'))
    expect(result.path.includes('predictions')).toBe(false)
    expect(engineForPredictionPath(result.path)).toBeUndefined()
  })

  it('id 形状不对时说清楚该长什么样（每种来源各说各的）', async () => {
    const { loader, deps } = harness()
    const result = await loader.load({
      sessionId: 'session-1',
      id: 'P0053',
      source: 'alphafold-db'
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('invalid-id')
    expect(result.detail).toContain('UniProt')
    expect(deps.fetchText).not.toHaveBeenCalled()
  })

  it('取回结果与网络失败分开命名（404 / 连接失败 / 超限 / 落盘失败各是各的）', async () => {
    const notFound = harness({
      fetchText: vi.fn().mockResolvedValue({ ok: false, reason: 'not-found', detail: 'HTTP 404' })
    })
    const notFoundResult = await notFound.loader.load({ sessionId: 'session-1', id: '1CRN' })
    expect(notFoundResult.ok).toBe(false)
    if (!notFoundResult.ok) expect(notFoundResult.reason).toBe('not-found')

    const network = harness({
      fetchText: vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'network-failed', detail: 'ECONNRESET' })
    })
    const networkResult = await network.loader.load({ sessionId: 'session-1', id: '1CRN' })
    expect(networkResult.ok).toBe(false)
    if (!networkResult.ok) expect(networkResult.reason).toBe('network-failed')

    const tooLarge = harness({
      fetchText: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'too-large',
        detail: `${STRUCTURE_REMOTE_MAX_BYTES} 上限`
      })
    })
    const tooLargeResult = await tooLarge.loader.load({ sessionId: 'session-1', id: '1CRN' })
    expect(tooLargeResult.ok).toBe(false)
    if (!tooLargeResult.ok) expect(tooLargeResult.reason).toBe('too-large')

    // 落盘失败必须自成一类：把它说成网络失败会让人去查网络（而网是通的）。
    // 用一个**文件**当目录（writeFile 占位）而不是 `/dev/null/...`：`/dev/null` 是 POSIX 字面量，
    // 在 Windows 上 `mkdir(recursive)` 会照着路径把它真的建出来 ⇒ 这条用例在 Windows 上会假绿/假红。
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'not a directory')
    const writeFails = harness({ workspaceFor: () => join(blocker, 'nested') })
    const writeResult = await writeFails.loader.load({ sessionId: 'session-1', id: '1CRN' })
    expect(writeResult.ok).toBe(false)
    if (!writeResult.ok) expect(writeResult.reason).toBe('write-failed')
  })
})

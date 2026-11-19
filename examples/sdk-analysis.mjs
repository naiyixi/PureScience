// 二十行：从零跑完一次分析。项目 → 会话 → 运行 → 等结果 → 收产物，全部走公开的 SDK。
// 用法：node examples/sdk-analysis.mjs "你的问题"      （需要 app 在跑，且已配置可用的模型提供商）
import { connectToPureScience } from 'purescience'

const question = process.argv[2] ?? '用一句话解释什么是双盲实验'
const client = await connectToPureScience() // 自动找到本机运行中的 app 与它的访问令牌

const project = await client.createProject({
  name: `SDK 示例 ${new Date().toISOString().slice(0, 16)}`
})
const run = await client.startRun({ project: project.id, prompt: question })

console.log(`运行 ${run.id} 已提交，状态 ${run.status}`)
const finished = await client.waitForRun(run.id, { timeoutMs: 10 * 60 * 1000 })

console.log(`结束状态：${finished.status}`)
if (finished.status !== 'completed') {
  // 失败要说清楚是哪一步：模型没配好、还是任务本身被拒绝。
  console.error(finished.error ?? '(运行未完成，且没有给出原因)')
  process.exit(1)
}

console.log(finished.output ?? '(没有输出)')
const artifacts = await client.listArtifacts(finished.sessionId)
for (const artifact of artifacts) console.log(`产物：${artifact.kind} ${artifact.path}`)

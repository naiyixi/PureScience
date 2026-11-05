# 认领与本轮结论：帧间隔仪器自证 + 百分位取最大值（2026-11-05 / 执行器）

> 为什么单独写一份：共享台账 `docs/plan-2026-10-03-next-queue-and-round-convention.md` 与
> `docs/plan-2026-11-04-v2.22-v2.27-schedule.md` 此刻都被并行会话持有（工作树里是一批未提交在制），
> 按约定不代别人落笔；本档声明本单元的归属、边界与下一轮第一步。

## 一 开工核对（防重做 + 并发 + 该谁做）

- `origin/main = 3f628550`；本机主树带 **42 处并行会话的在制路径**（`src/main/reviewer/**`、
  `src/main/session-persistence/**`、`src/main/notebook/**`、`src/main/references/screening-service.ts`、
  `src/main/update/service.ts`、`src/main/ipc.ts`、九份 i18n、`src/renderer/src/pages/home/**`、
  `prisma/schema.prisma` 与四份计划/证据档）⇒ 一个字节没碰；本单元全程在隔离工作树 `/tmp/ps-perf`
  （`node_modules` 软链；`out/` 自建，因为并行会话正在用共享产物目录）。
- 与并行会话路径**不相交**：本笔只碰 `e2e/perf/smoothness.spec.ts`、新增
  `src/shared/perf-frame-cadence{,.test}.ts` 与本证据/认领两份文档。
- 排期口径核对：v2.23.0 第一条是「先修测量方法」。本轮**没有**去改那条描述里的数字，而是先检验它的成因
  ——结果成因证不出来、仪器自身另有两处缺陷（详见证据档）。这与「先有仪器再优化」同一顺序。

## 二 结论（三句话）

1. **81 ms 的「饱和」在本机复现不出来**：空白页在「可见但非 key / 提到最前 / 隐藏」三种窗口状态下，
   默认光栅与 `--disable-gpu` 的中位帧间隔都是 **16.7–18.1 ms** ⇒ 不能把它归因成「窗口不在前台」。
2. **仪器的百分比会退化成最大值**：旧代码 `floor(n*0.95)` 在 `n<20` 时取到最后一个元素；`measureIpc` 只采
   12 次 ⇒ 它打印的「p95」是 12 个样本里的最大值。已换成最近秩 + **样本不足返回 null**（印 `n/a`）。
3. **仪器现在先自证再取数**：测前采 750 ms 空闲节奏，低于 50 fps 就判 `throttled`，此时
   `frames/p95/max` 一律印 `n/a` 加原因，绝不印一个读不成产品的数字。

## 三 交付与读数

见 `docs/evidence/2026-11-05-perf-instrument-frame-cadence.md`：假设检验表、两处缺陷的可复算证明、
三个文件的改法、真机 perf spec 读数（1 passed / 10.2 s，含 `frames=2 … p95=n/a (fewer than 20 samples)`
这一行）、变异自证（把阈值临时改成 2000 fps ⇒ 拒绝分支可达、一个数字都不印）、六条边界。

## 四 下一轮第一步

1. **`81 ms` 的两种候选必须能分开**：本笔之后每次读数都带 `n` 与 `max`。下一步取一次真读数
   （长会话 + `--disable-gpu`，同一窗口），看是「每帧都慢（max/p95 与 n 同阶）」还是「个别停顿
   （max ≫ p95）」——前者是绘制吞吐上限，后者是一次 GC/长任务。
2. **资源闸门**：本机此刻空闲页 ~60 MB、swap 已用 7.1/8.2 GB（WorkBuddy 两个常驻 Electron 占着内存）。
   要取第 1 条那个读数，先确认空闲页回升；否则只做不需要窗口的部分（v2.22.0 剩余两条仍被并行会话的
   `src/main/update/service.ts` / `i18n/**` 在制挡住）。
3. **排期档的两行勾选**（v2.23.0 第一条的状态、v2.24.0 cask 已发）等并行会话落定后一并改写，本笔不动它。

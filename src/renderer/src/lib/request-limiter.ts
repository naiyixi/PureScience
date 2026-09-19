// Every renderer read of project files, artifact previews or session pages lands in the same main-process
// engine, and U11 showed that engine queues rather than parallelises: the same 59 reads measured a ~6x deeper
// queue when 52 of them ran at once than when 4 did, with no throughput to show for it. A fan-out therefore
// has to be bounded somewhere, and it may as well be bounded the same way everywhere.
//
// Tasks stay FIFO and a completion pumps the next queued task, so a limiter can never starve a request it
// accepted.
export type RequestLimiter = <Result>(task: () => Promise<Result>) => Promise<Result>

export const createRequestLimiter = (maxConcurrency: number): RequestLimiter => {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error(`Request limiter concurrency must be a positive integer: ${maxConcurrency}`)
  }
  let activeCount = 0
  const pending: Array<() => void> = []

  const pump = (): void => {
    while (activeCount < maxConcurrency) {
      const run = pending.shift()
      if (!run) return
      activeCount += 1
      run()
    }
  }

  return <Result>(task: () => Promise<Result>): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      pending.push(() => {
        // Both outcomes release the slot: a rejected read must not hold the fan-out open.
        void task()
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1
            pump()
          })
      })
      pump()
    })
}

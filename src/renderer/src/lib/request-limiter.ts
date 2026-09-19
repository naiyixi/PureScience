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
        // The slot must be released on every path. A caller whose task throws synchronously (or returns
        // something that is not a promise) would otherwise strand its slot, and four of those starve every
        // later read for the life of the process — the shared preview limiter made that failure real.
        let started: Promise<Result>
        try {
          started = Promise.resolve(task())
        } catch (error) {
          activeCount -= 1
          pump()
          reject(error)
          return
        }
        void started
          .then(resolve, reject)
          .finally(() => {
            activeCount -= 1
            pump()
          })
      })
      pump()
    })
}

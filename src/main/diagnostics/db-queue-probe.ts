// The acquire path's query segment waits 21-336 ms depending on the moment while the file system canary stays
// at 0-1 ms, the fs pool is idle and the event loop is healthy — so the remaining shared resource is the
// database engine, which every Prisma query in the process queues through.
//
// This is the same canary pattern as the fs probe, aimed at the engine: a trivial query is started alongside
// the operation being measured and awaited after it, so a slow reading means the engine was busy with someone
// else's work at that moment, while a fast one clears the engine and sends the search back to this specific
// query. It takes the query as a function so it can be exercised without a database.
const startDbCanary = async (runTrivialQuery: () => Promise<unknown>): Promise<number> => {
  const startedAt = Date.now()
  try {
    await runTrivialQuery()
  } catch {
    // A failed canary is not a measurement; report it as unknown rather than as a number.
    return -1
  }
  return Date.now() - startedAt
}

export { startDbCanary }

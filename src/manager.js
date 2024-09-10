const assert = require('node:assert')
const EventEmitter = require('node:events')
const { randomUUID } = require('node:crypto')
const { serializeError: stringify } = require('serialize-error')
const { delay } = require('./tools')
const Attorney = require('./attorney')
const Worker = require('./worker')
const plans = require('./plans')

const { QUEUES: TIMEKEEPER_QUEUES } = require('./timekeeper')
const { QUEUE_POLICIES } = plans

const INTERNAL_QUEUES = Object.values(TIMEKEEPER_QUEUES).reduce((acc, i) => ({ ...acc, [i]: i }), {})

const events = {
  error: 'error',
  wip: 'wip'
}

const resolveWithinSeconds = async (promise, seconds) => {
  const timeout = Math.max(1, seconds) * 1000
  const reject = delay(timeout, `handler execution exceeded ${timeout}ms`)

  let result

  try {
    result = await Promise.race([promise, reject])
  } finally {
    reject.abort()
  }

  return result
}

class Manager extends EventEmitter {
  constructor (db, config) {
    super()

    this.config = config
    this.db = db

    this.events = events
    this.wipTs = Date.now()
    this.workers = new Map()
    this.queues = null

    // exported api to index
    this.functions = [
      this.complete,
      this.cancel,
      this.resume,
      this.deleteJob,
      this.fail,
      this.fetch,
      this.work,
      this.offWork,
      this.notifyWorker,
      this.publish,
      this.subscribe,
      this.unsubscribe,
      this.insert,
      this.send,
      this.sendDebounced,
      this.sendThrottled,
      this.sendAfter,
      this.createQueue,
      this.updateQueue,
      this.deleteQueue,
      this.purgeQueue,
      this.getQueueSize,
      this.getQueue,
      this.getQueues,
      this.getJobById
    ]
  }

  start () {
    this.stopped = false
    this.queueCacheInterval = setInterval(() => this.onCacheQueues(), 60 * 1000)
    this.onCacheQueues()
  }

  async onCacheQueues () {
    try {
      const queues = await this.getQueues()
      this.queues = queues.reduce((acc, i) => { acc[i.name] = i; return acc }, {})
    } catch (error) {
      this.emit(events.error, { ...error, message: error.message, stack: error.stack })
    }
  }

  async getQueueCache (name) {
    let queue = this.queues[name]

    if (queue) {
      return queue
    }

    queue = await this.getQueue(name)

    if (!queue) {
      throw new Error(`Queue ${name} does not exist`)
    }

    this.queues[name] = queue

    return queue
  }

  async stop () {
    this.stopped = true

    clearInterval(this.queueCacheInterval)

    for (const worker of this.workers.values()) {
      if (!INTERNAL_QUEUES[worker.name]) {
        await this.offWork(worker.name)
      }
    }
  }

  async failWip () {
    for (const worker of this.workers.values()) {
      const jobIds = worker.jobs.map(j => j.id)
      if (jobIds.length) {
        await this.fail(worker.name, jobIds, 'pg-boss shut down while active')
      }
    }
  }

  async work (name, ...args) {
    const { options, callback } = Attorney.checkWorkArgs(name, args, this.config)
    return await this.watch(name, options, callback)
  }

  addWorker (worker) {
    this.workers.set(worker.id, worker)
  }

  removeWorker (worker) {
    this.workers.delete(worker.id)
  }

  getWorkers () {
    return Array.from(this.workers.values())
  }

  emitWip (name) {
    if (!INTERNAL_QUEUES[name]) {
      const now = Date.now()

      if (now - this.wipTs > 2000) {
        this.emit(events.wip, this.getWipData())
        this.wipTs = now
      }
    }
  }

  getWipData (options = {}) {
    const { includeInternal = false } = options

    const data = this.getWorkers()
      .map(({
        id,
        name,
        options,
        state,
        jobs,
        createdOn,
        lastFetchedOn,
        lastJobStartedOn,
        lastJobEndedOn,
        lastError,
        lastErrorOn
      }) => ({
        id,
        name,
        options,
        state,
        count: jobs.length,
        createdOn,
        lastFetchedOn,
        lastJobStartedOn,
        lastJobEndedOn,
        lastError,
        lastErrorOn
      }))
      .filter(i => i.count > 0 && (!INTERNAL_QUEUES[i.name] || includeInternal))

    return data
  }

  async watch (name, options, callback) {
    if (this.stopped) {
      throw new Error('Workers are disabled. pg-boss is stopped')
    }

    const {
      pollingInterval: interval = this.config.pollingInterval,
      batchSize,
      includeMetadata = false,
      priority = true
    } = options

    const id = randomUUID({ disableEntropyCache: true })

    const fetch = () => this.fetch(name, { batchSize, includeMetadata, priority })

    const onFetch = async (jobs) => {
      if (!jobs.length) {
        return
      }

      if (this.config.__test__throw_worker) {
        throw new Error('__test__throw_worker')
      }

      this.emitWip(name)

      const maxExpiration = jobs.reduce((acc, i) => Math.max(acc, i.expireInSeconds), 0)
      const jobIds = jobs.map(job => job.id)

      try {
        const result = await resolveWithinSeconds(callback(jobs), maxExpiration)
        this.complete(name, jobIds, jobIds.length === 1 ? result : undefined)
      } catch (err) {
        this.fail(name, jobIds, err)
      }

      this.emitWip(name)
    }

    const onError = error => {
      this.emit(events.error, { ...error, message: error.message, stack: error.stack, queue: name, worker: id })
    }

    const worker = new Worker({ id, name, options, interval, fetch, onFetch, onError })

    this.addWorker(worker)

    worker.start()

    return id
  }

  async offWork (value) {
    assert(value, 'Missing required argument')

    const query = (typeof value === 'string')
      ? { filter: i => i.name === value }
      : (typeof value === 'object' && value.id)
          ? { filter: i => i.id === value.id }
          : null

    assert(query, 'Invalid argument. Expected string or object: { id }')

    const workers = this.getWorkers().filter(i => query.filter(i) && !i.stopping && !i.stopped)

    if (workers.length === 0) {
      return
    }

    for (const worker of workers) {
      worker.stop()
    }

    setImmediate(async () => {
      while (!workers.every(w => w.stopped)) {
        await delay(1000)
      }

      for (const worker of workers) {
        this.removeWorker(worker)
      }
    })
  }

  notifyWorker (workerId) {
    if (this.workers.has(workerId)) {
      this.workers.get(workerId).notify()
    }
  }

  async subscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')
    const sql = plans.subscribe(this.config.schema)
    return await this.db.executeSql(sql, [event, name])
  }

  async unsubscribe (event, name) {
    assert(event, 'Missing required argument')
    assert(name, 'Missing required argument')
    const sql = plans.unsubscribe(this.config.schema)
    return await this.db.executeSql(sql, [event, name])
  }

  async publish (event, ...args) {
    assert(event, 'Missing required argument')
    const sql = plans.getQueuesForEvent(this.config.schema)
    const { rows } = await this.db.executeSql(sql, [event])

    await Promise.allSettled(rows.map(({ name }) => this.send(name, ...args)))
  }

  async send (...args) {
    const { name, data, options } = Attorney.checkSendArgs(args, this.config)

    return await this.createJob(name, data, options)
  }

  async sendAfter (name, data, options, after) {
    options = options ? { ...options } : {}
    options.startAfter = after

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendThrottled (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = false
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async sendDebounced (name, data, options, seconds, key) {
    options = options ? { ...options } : {}
    options.singletonSeconds = seconds
    options.singletonNextSlot = true
    options.singletonKey = key

    const result = Attorney.checkSendArgs([name, data, options], this.config)

    return await this.createJob(result.name, result.data, result.options)
  }

  async createJob (name, data, options, singletonOffset = 0) {
    const {
      id = null,
      db: wrapper,
      priority,
      startAfter,
      singletonKey = null,
      singletonSeconds,
      expireIn,
      expireInDefault,
      keepUntil,
      keepUntilDefault,
      retryLimit,
      retryLimitDefault,
      retryDelay,
      retryDelayDefault,
      retryBackoff,
      retryBackoffDefault
    } = options

    const values = [
      id, // 1
      name, // 2
      data, // 3
      priority, // 4
      startAfter, // 5
      singletonKey, // 6
      singletonSeconds, // 7
      singletonOffset, // 8
      expireIn, // 9
      expireInDefault, // 10
      keepUntil, // 11
      keepUntilDefault, // 12
      retryLimit, // 13
      retryLimitDefault, // 14
      retryDelay, // 15
      retryDelayDefault, // 16
      retryBackoff, // 17
      retryBackoffDefault // 18
    ]

    const db = wrapper || this.db

    const { table } = await this.getQueueCache(name)

    const sql = plans.insertJob(this.config.schema, table)

    const { rows } = await db.executeSql(sql, values)

    if (rows.length === 1) {
      return rows[0].id
    }

    if (!options.singletonNextSlot) {
      return null
    }

    // delay starting by the offset to honor throttling config
    options.startAfter = this.getDebounceStartAfter(singletonSeconds, this.timekeeper.clockSkew)

    // toggle off next slot config for round 2
    options.singletonNextSlot = false

    singletonOffset = singletonSeconds

    return await this.createJob(name, data, options, singletonOffset)
  }

  async insert (name, jobs, options = {}) {
    assert(Array.isArray(jobs), 'jobs argument should be an array')

    const { table } = await this.getQueueCache(name)

    const db = options.db || this.db

    const params = [
      JSON.stringify(jobs), // 1
      this.config.expireIn, // 2
      this.config.keepUntil, // 3
      this.config.retryLimit, // 4
      this.config.retryDelay, // 5
      this.config.retryBackoff // 6
    ]

    const sql = plans.insertJobs(this.config.schema, table, name)

    const { rows } = await db.executeSql(sql, params)

    return (rows.length) ? rows.map(i => i.id) : null
  }

  getDebounceStartAfter (singletonSeconds, clockOffset) {
    const debounceInterval = singletonSeconds * 1000

    const now = Date.now() + clockOffset

    const slot = Math.floor(now / debounceInterval) * debounceInterval

    // prevent startAfter=0 during debouncing
    let startAfter = (singletonSeconds - Math.floor((now - slot) / 1000)) || 1

    if (singletonSeconds > 1) {
      startAfter++
    }

    return startAfter
  }

  async fetch (name, options = {}) {
    Attorney.checkFetchArgs(name, options)

    const db = options.db || this.db

    const { table } = await this.getQueueCache(name)

    const sql = plans.fetchNextJob({ ...options, schema: this.config.schema, table, name, limit: options.batchSize })

    let result

    try {
      result = await db.executeSql(sql)
    } catch (err) {
      // errors from fetchquery should only be unique constraint violations
    }

    return result?.rows || []
  }

  mapCompletionIdArg (id, funcName) {
    const errorMessage = `${funcName}() requires an id`

    assert(id, errorMessage)

    const ids = Array.isArray(id) ? id : [id]

    assert(ids.length, errorMessage)

    return ids
  }

  mapCompletionDataArg (data) {
    if (data === null || typeof data === 'undefined' || typeof data === 'function') { return null }

    const result = (typeof data === 'object' && !Array.isArray(data))
      ? data
      : { value: data }

    return stringify(result)
  }

  mapCommandResponse (ids, result) {
    return {
      jobs: ids,
      requested: ids.length,
      affected: result && result.rows ? parseInt(result.rows[0].count) : 0
    }
  }

  async complete (name, id, data, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'complete')
    const { table } = await this.getQueueCache(name)
    const sql = plans.completeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async fail (name, id, data, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'fail')
    const queue = await this.getQueueCache(name)
    const sql = plans.failJobsById(this.config.schema, queue)
    const result = await db.executeSql(sql, [name, ids, this.mapCompletionDataArg(data)])
    return this.mapCommandResponse(ids, result)
  }

  async cancel (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'cancel')
    const { table } = await this.getQueueCache(name)
    const sql = plans.cancelJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async deleteJob (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'deleteJob')
    const { table } = await this.getQueueCache(name)
    const sql = plans.deleteJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async resume (name, id, options = {}) {
    Attorney.assertQueueName(name)
    const db = options.db || this.db
    const ids = this.mapCompletionIdArg(id, 'resume')
    const { table } = await this.getQueueCache(name)
    const sql = plans.resumeJobs(this.config.schema, table)
    const result = await db.executeSql(sql, [name, ids])
    return this.mapCommandResponse(ids, result)
  }

  async createQueue (name, options = {}) {
    name = name || options.name

    Attorney.assertQueueName(name)

    const { policy = QUEUE_POLICIES.standard } = options

    assert(policy in QUEUE_POLICIES, `${policy} is not a valid queue policy`)

    const {
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      archive,
      deadLetter
    } = Attorney.checkQueueArgs(options)

    if (deadLetter) {
      Attorney.assertQueueName(deadLetter)
      assert.notStrictEqual(name, deadLetter, 'deadLetter cannot equal name')
    }

    // todo: pull in defaults from constructor config
    const data = {
      policy,
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      archive,
      deadLetter
    }

    const sql = plans.createQueue(this.config.schema)
    await this.db.executeSql(sql, [name, data])
  }

  async getQueues (names) {
    if (names) {
      names = Array.isArray(names) ? names : [names]
      for (const name of names) {
        Attorney.assertQueueName(name)
      }
    }

    const sql = plans.getQueues(this.config.schema, names)
    const { rows } = await this.db.executeSql(sql)
    return rows
  }

  async updateQueue (name, options = {}) {
    Attorney.assertQueueName(name)

    const { policy = QUEUE_POLICIES.standard } = options

    assert(policy in QUEUE_POLICIES, `${policy} is not a valid queue policy`)

    //
    const {
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    } = Attorney.checkQueueArgs(options)

    if (deadLetter) {
      Attorney.assertQueueName(deadLetter)
      assert.notStrictEqual(name, deadLetter, 'deadLetter cannot equal name')
    }

    const params = [
      name,
      policy,
      retryLimit,
      retryDelay,
      retryBackoff,
      expireInSeconds,
      retentionMinutes,
      deadLetter
    ]

    const sql = plans.updateQueue(this.config.schema, { deadLetter })

    await this.db.executeSql(sql, params)
  }

  async getQueue (name) {
    Attorney.assertQueueName(name)

    const sql = plans.getQueues(this.config.schema, [name])
    const { rows } = await this.db.executeSql(sql)

    return rows[0] || null
  }

  async deleteQueue (name) {
    Attorney.assertQueueName(name)

    try {
      await this.getQueueCache(name)
      const sql = plans.deleteQueue(this.config.schema)
      await this.db.executeSql(sql, [name])
    } catch {}
  }

  async purgeQueue (name) {
    Attorney.assertQueueName(name)
    const { table } = await this.getQueueCache(name)
    const sql = plans.purgeQueue(this.config.schema, table)
    await this.db.executeSql(sql, [name])
  }

  async getQueueSize (name, options) {
    Attorney.assertQueueName(name)

    const { table } = await this.getQueueCache(name)

    const sql = plans.getQueueSize(this.config.schema, table, options?.before)

    const result = await this.db.executeSql(sql, [name])

    return result ? parseFloat(result.rows[0].count) : null
  }

  async getJobById (name, id, options = {}) {
    Attorney.assertQueueName(name)

    const db = options.db || this.db

    const { table } = await this.getQueueCache(name)

    const sql = plans.getJobById(this.config.schema, table)

    const result1 = await db.executeSql(sql, [name, id])

    if (result1?.rows?.length === 1) {
      return result1.rows[0]
    } else if (options.includeArchive) {
      const result2 = await db.executeSql(plans.getArchivedJobById(this.config.schema), [name, id])
      return result2?.rows[0] || null
    } else {
      return null
    }
  }
}

module.exports = Manager

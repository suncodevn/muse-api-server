'use strict';

/**
 * Job dispatcher - durable, multi-node-safe execution of image & video jobs.
 *
 * Flow
 *  1. API handlers persist a job with status "queued" (MongoDB is the queue).
 *  2. Whenever local upstream capacity is free, the dispatcher atomically
 *     claims the oldest queued job of that type (findOneAndUpdate), so several
 *     API nodes can share one database without double-processing.
 *  3. The job runs on a pooled upstream account. Progress and a heartbeat are
 *     written periodically.
 *  4. On completion the output is stored, the job is finalized with a
 *     conditional update (guards against concurrent cancellation), usage is
 *     recorded, local waiters are notified and the webhook is fired.
 *
 * Resilience
 *  - Account-level failures (auth / upstream errors / timeouts) are retried on
 *    a different account up to `max_attempts`.
 *  - Jobs whose heartbeat goes stale (crashed node) are re-queued or failed
 *    with `job_interrupted`.
 *  - Jobs that wait longer than their queue deadline fail with `queue_timeout`.
 *  - Graceful shutdown stops claiming, waits for in-flight jobs, and re-queues
 *    anything that could not finish in time.
 */

const { EventEmitter } = require('events');
const config = require('../config');
const { logger, sanitize } = require('../logger');
const { Job, TERMINAL_STATUSES } = require('../models');
const { pool } = require('./pool');
const storage = require('./storage');
const media = require('./media');
const usage = require('./usage');
const webhook = require('./webhook');
const { serializeJob } = require('../serializers');
const { detectMediaType } = require('../utils/mime');
const { generateId } = require('../utils/crypto');
const { ApiError, ErrorCodes, classifyUpstreamError, isAccountLevelFailure } = require('../errors');

const log = logger.child({ component: 'dispatcher' });

const JOB_TYPES = ['image', 'video'];
const PROGRESS_WRITE_INTERVAL_MS = 5000;
const SWEEP_INTERVAL_MS = 15000;
const PENDING_COUNT_REFRESH_MS = 2000;
const ACQUIRE_WAIT_MS = 5000;
// Typical generation durations used for the progress estimate curve.
const EXPECTED_DURATION_MS = { image: 45000, video: 150000 };

class Dispatcher extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.nodeId = config.server.nodeId;
    this.running = new Map(); // jobId -> context
    this.acquiring = { image: 0, video: 0 };
    this.waiters = new Map(); // jobId -> Set<callback>
    this.timers = [];
    this.started = false;
    this.stopping = false;
    this.ticking = false;
    this.rekick = false;
    this.pendingCount = 0;
    this.pendingCountAt = 0;
    this.maxPendingGlobal = config.jobs.maxPendingGlobal;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start() {
    if (this.started) return;
    this.started = true;
    webhook.startWebhooks();
    this.timers.push(setInterval(() => this.kick(), config.jobs.pollIntervalMs));
    this.timers.push(setInterval(() => this._sweep().catch((err) => log.warn({ err: err.message }, 'Sweep failed')), SWEEP_INTERVAL_MS));
    this.timers.forEach((t) => t.unref?.());
    pool.on('slot-released', () => this.kick());
    this._sweep().catch(() => {});
    this.kick();
    log.info('Job dispatcher started');
  }

  setMaxPendingGlobal(value) {
    if (Number.isInteger(value) && value >= 1) this.maxPendingGlobal = value;
  }

  /** Stops claiming work, drains active executions, then re-queues the rest. */
  async stop(graceMs = config.server.shutdownGraceMs) {
    this.stopping = true;
    this.timers.forEach((t) => clearInterval(t));
    const deadline = Date.now() + graceMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (this.running.size > 0) {
      const ids = [...this.running.keys()];
      log.warn({ jobs: ids.length }, 'Re-queuing unfinished jobs before shutdown');
      for (const id of ids) {
        const ctx = this.running.get(id);
        if (!ctx) continue;
        ctx.controller.abort(new Error('Job interrupted by server shutdown.'));
        await Job.updateOne(this._executionFilter(ctx.job),
          { $set: { status: 'queued', node_id: null, execution_id: null, account_id: null, progress: 0, progress_text: 'Re-queued after server restart', heartbeat_at: null }, $inc: { attempts: -1 } }
        ).catch((err) => log.error({ err: err.message }, 'Failed to re-queue job'));
      }
    }
    webhook.stopWebhooks();
  }

  /** Requests a scheduling pass as soon as possible (coalesced). */
  kick() {
    if (!this.started || this.stopping) return;
    if (this.ticking) {
      this.rekick = true;
      return;
    }
    setImmediate(() => this._tick());
  }

  // ---------------------------------------------------------------------------
  // Job creation (called by API handlers)
  // ---------------------------------------------------------------------------

  async _refreshPendingCount(force = false) {
    if (!force && Date.now() - this.pendingCountAt < PENDING_COUNT_REFRESH_MS) return this.pendingCount;
    this.pendingCount = await Job.countDocuments({ status: { $in: ['queued', 'running'] } });
    this.pendingCountAt = Date.now();
    return this.pendingCount;
  }

  /**
   * Returns an existing job created with the same Idempotency-Key, or null.
   * Throws 409 when the key was reused with a different request body.
   */
  async findIdempotentJob(apiKeyId, idempotencyKey, fingerprint) {
    if (!idempotencyKey) return null;
    const existing = await Job.findOne({ api_key_id: apiKeyId, idempotency_key: idempotencyKey }).lean();
    if (!existing) return null;
    if (existing.request_fingerprint !== fingerprint) throw new ApiError(ErrorCodes.IDEMPOTENCY_CONFLICT);
    return existing;
  }

  /** Fails fast (before any expensive work) when the job cannot be accepted. */
  async assertCanEnqueue(type, apiKey) {
    if (this.stopping) throw new ApiError(ErrorCodes.SERVICE_SHUTTING_DOWN, { retryAfter: 5 });
    if (!pool.hasCapability(type)) {
      throw new ApiError(ErrorCodes.NO_ACCOUNTS_AVAILABLE, { message: `No upstream accounts are configured for ${type} generation.`, retryAfter: 60 });
    }
    const pending = await this._refreshPendingCount();
    if (pending >= this.maxPendingGlobal) throw new ApiError(ErrorCodes.QUEUE_FULL, { retryAfter: 30 });

    const limit = apiKey.max_concurrent_jobs || config.rateLimit.defaultMaxConcurrentJobs;
    const active = await Job.countDocuments({ api_key_id: apiKey._id, status: { $in: ['queued', 'running'] } });
    if (active >= limit) {
      throw new ApiError(ErrorCodes.CONCURRENCY_LIMIT_EXCEEDED, {
        message: `This API key already has ${active} queued or running jobs (limit: ${limit}). Wait for some to finish.`,
        retryAfter: 10,
        details: { limit, active }
      });
    }
  }

  /**
   * Persists a new queued job.
   * @returns {Promise<{ job: object, replayed: boolean }>}
   */
  async createJob({ apiKey, type, prompt, params, reference, webhookUrl, idempotencyKey, fingerprint, metadata }) {
    const queueTimeout = config.jobs[type].queueTimeoutMs;
    try {
      const doc = await Job.create({
        type,
        api_key_id: apiKey._id,
        prompt,
        params,
        reference,
        webhook: { url: webhookUrl || null },
        idempotency_key: idempotencyKey || null,
        request_fingerprint: fingerprint || null,
        metadata: metadata || {},
        max_attempts: config.jobs.maxAttempts,
        queue_deadline: queueTimeout > 0 ? new Date(Date.now() + queueTimeout) : null
      });
      this.pendingCount += 1;
      this.kick();
      log.info({ job: doc._id, type, apiKey: apiKey._id }, 'Job queued');
      return { job: doc.toObject(), replayed: false };
    } catch (err) {
      // Two concurrent requests with the same Idempotency-Key: return the winner.
      if (err?.code === 11000 && idempotencyKey) {
        const existing = await this.findIdempotentJob(apiKey._id, idempotencyKey, fingerprint);
        if (existing) return { job: existing, replayed: true };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Cancellation & waiting
  // ---------------------------------------------------------------------------

  async cancel(jobId, apiKeyId, { admin = false } = {}) {
    const owner = admin ? {} : { api_key_id: apiKeyId };
    const doc = await Job.findOneAndUpdate(
      { _id: jobId, ...owner, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'canceled', completed_at: new Date(), progress_text: 'Canceled by client', error: { code: null, message: null } } },
      { returnDocument: 'after' }
    ).lean();
    if (!doc) {
      const exists = await Job.exists({ _id: jobId, ...owner });
      if (!exists) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such job: '${jobId}'.`, param: 'id' });
      throw new ApiError(ErrorCodes.JOB_NOT_CANCELLABLE);
    }
    const ctx = this.running.get(jobId);
    if (ctx) {
      ctx.canceled = true;
      ctx.controller.abort(new Error('Job canceled by client.'));
    }
    this._finalize(doc);
    return doc;
  }

  /**
   * Resolves with the job document once it reaches a terminal state, or with
   * the latest snapshot when `timeoutMs` elapses. Works across nodes by
   * combining in-process notifications with periodic database polling.
   */
  waitForTerminal(jobId, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let pollTimer = null;
      let timeoutTimer = null;

      const finish = (doc) => {
        if (done) return;
        done = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        const set = this.waiters.get(jobId);
        if (set) {
          set.delete(onTerminal);
          if (set.size === 0) this.waiters.delete(jobId);
        }
        resolve(doc);
      };
      const onTerminal = (doc) => finish(doc);

      if (!this.waiters.has(jobId)) this.waiters.set(jobId, new Set());
      this.waiters.get(jobId).add(onTerminal);

      const poll = async () => {
        const doc = await Job.findById(jobId).lean().catch(() => null);
        if (doc && TERMINAL_STATUSES.includes(doc.status)) finish(doc);
        return doc;
      };
      pollTimer = setInterval(poll, 2000);
      timeoutTimer = setTimeout(async () => finish(await poll()), Math.max(0, timeoutMs));
      poll();
    });
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  async _tick() {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      for (const type of JOB_TYPES) {
        let free = pool.availableSlots(type) - this.acquiring[type];
        while (free > 0 && !this.stopping) {
          const job = await this._claim(type);
          if (!job) break;
          free -= 1;
          this._run(job).catch((err) => log.error({ job: job._id, err: err.message }, 'Job runner crashed'));
        }
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Dispatcher tick failed');
    } finally {
      this.ticking = false;
      if (this.rekick) {
        this.rekick = false;
        this.kick();
      }
    }
  }

  _claim(type) {
    const now = new Date();
    const filter = { status: 'queued', type };
    if (config.jobs[type].queueTimeoutMs > 0) {
      filter.$or = [{ queue_deadline: null }, { queue_deadline: { $gt: now } }];
    }
    const freeAccounts = pool.availableAccountIds?.(type);
    if (freeAccounts?.length) {
      // A retried job must not block fresh jobs from using other free accounts.
      filter.$nor = [{ excluded_accounts: { $all: freeAccounts } }];
    }
    return Job.findOneAndUpdate(
      filter,
      {
        $set: { status: 'running', node_id: this.nodeId, execution_id: generateId('run'), started_at: now, heartbeat_at: now, progress: 1, progress_text: 'Waiting for an available upstream account' },
        $inc: { attempts: 1 }
      },
      { sort: { created_at: 1 }, returnDocument: 'after' }
    ).lean();
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  _executionFilter(job) {
    return { _id: job._id, status: 'running', node_id: this.nodeId, execution_id: job.execution_id };
  }

  async _run(job) {
    const ctx = { job, lease: null, progress: 1, progressText: job.progress_text, startedAt: Date.now(), canceled: false, controller: new AbortController() };
    this.running.set(job._id, ctx);
    this.acquiring[job.type] += 1;
    let acquiringReleased = false;
    const releaseAcquiring = () => {
      if (acquiringReleased) return;
      acquiringReleased = true;
      this.acquiring[job.type] = Math.max(0, this.acquiring[job.type] - 1);
    };

    const progressTimer = setInterval(() => this._writeProgress(ctx), PROGRESS_WRITE_INTERVAL_MS);
    progressTimer.unref?.();

    let outputFile = null;
    try {
      const references = await this._loadReferences(job);
      ctx.controller.signal.throwIfAborted();

      ctx.lease = await pool.acquire(job.type, { exclude: job.excluded_accounts || [], waitMs: ACQUIRE_WAIT_MS });
      ctx.controller.signal.throwIfAborted();
      releaseAcquiring();
      ctx.progress = 3;
      ctx.progressText = 'Generating';
      const owned = await Job.updateOne(this._executionFilter(job), { $set: { account_id: ctx.lease.accountId, progress: 3, progress_text: 'Generating' } });
      if (!owned.matchedCount) {
        ctx.canceled = true;
        ctx.controller.abort(new Error('Job execution no longer owns this job.'));
        ctx.controller.signal.throwIfAborted();
      }

      const isVideo = job.type === 'video';
      const timeout = config.jobs[job.type].timeoutMs;
      const onProgress = (text) => this._onProgress(ctx, text);
      const call = isVideo
        ? ctx.lease.client.generateVideo(job.prompt, {
          ref_image: references.image,
          ref_video: references.video,
          ref_images: references.images,
          aspect_ratio: job.params?.aspect_ratio || undefined,
          duration: job.params?.duration || undefined,
          timeout,
          signal: ctx.controller.signal,
          maxBytes: config.storage.maxVideoBytes,
          onProgress
        })
        : ctx.lease.client.generateImage(job.prompt, {
          ref_image: references.image,
          aspect_ratio: job.params?.aspect_ratio || undefined,
          timeout,
          signal: ctx.controller.signal,
          maxBytes: config.storage.maxImageBytes,
          onProgress
        });

      // Hard guard on top of the client's own timeout (covers the download phase).
      const result = await withTimeout(call, timeout + 60000, `${isVideo ? 'Video' : 'Image'} generation timed out.`, ctx.controller);
      ctx.controller.signal.throwIfAborted();

      if (!result?.success) {
        // The account worked; the model simply declined / produced nothing.
        ctx.lease.release({ success: true });
        throw new ApiError(ErrorCodes.CONTENT_NOT_GENERATED, { message: sanitize(result?.error) || undefined });
      }
      if (!result.buffer || result.buffer.length === 0) {
        throw new ApiError(ErrorCodes.UPSTREAM_ERROR, { message: 'The upstream provider reported success but returned no media.' });
      }
      ctx.lease.release({ success: true });

      const detected = detectMediaType(result.buffer);
      const mimeType = detected?.mime || result.mimeType || (isVideo ? 'video/mp4' : 'image/webp');
      outputFile = await storage.saveFile({
        apiKeyId: job.api_key_id,
        purpose: 'output',
        kind: job.type,
        mimeType,
        buffer: result.buffer
      });

      const updated = await Job.findOneAndUpdate(
        this._executionFilter(job),
        {
          $set: {
            status: 'succeeded',
            progress: 100,
            progress_text: 'Completed',
            completed_at: new Date(),
            output: { file_id: outputFile._id, mime_type: mimeType, bytes: result.buffer.length, text: result.text ? sanitize(result.text).slice(0, 4000) : null },
            error: { code: null, message: null }
          }
        },
        { returnDocument: 'after' }
      ).lean();

      if (!updated) {
        // Canceled (or reclaimed) while running: discard the orphaned output.
        await storage.deleteFile(outputFile).catch(() => {});
        log.info({ job: job._id }, 'Job result discarded (job no longer running on this node)');
        return;
      }
      log.info({ job: job._id, type: job.type, account: ctx.lease.accountId, ms: Date.now() - ctx.startedAt, bytes: result.buffer.length }, 'Job succeeded');
      outputFile = null; // The succeeded job now owns the stored file.
      this._finalize(updated);
    } catch (err) {
      releaseAcquiring();
      const apiError = classifyUpstreamError(err);
      // A database error may have occurred after committing success. Keep the
      // file on ambiguous writes; retention cleanup handles unused metadata.
      if (ctx.lease && !ctx.lease.released) ctx.lease.release(ctx.canceled || this.stopping ? { success: true } : { success: false, error: apiError });
      await this._handleFailure(ctx, apiError);
    } finally {
      clearInterval(progressTimer);
      releaseAcquiring();
      if (this.running.get(job._id) === ctx) this.running.delete(job._id);
      this.kick();
    }
  }

  async _loadReferences(job) {
    const refs = { image: null, video: null };
    const load = async (fileId, param) => {
      try {
        const doc = await storage.getFileOrThrow(fileId, { apiKeyId: job.api_key_id, param });
        return await media.toUpstreamPayload(doc);
      } catch (err) {
        throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: `The reference file '${fileId}' is no longer available.`, param });
      }
    };
    if (job.reference?.image_file_id) refs.image = await load(job.reference.image_file_id, 'reference_image');
    if (job.reference?.images?.length) {
      refs.images = [];
      for (const [index, item] of job.reference.images.entries()) {
        refs.images.push({ image: await load(item.file_id, `reference_images.${index}.image`), label: item.label, role: item.role });
      }
    }
    if (job.reference?.video_file_id) refs.video = await load(job.reference.video_file_id, 'reference_video');
    return refs;
  }

  _onProgress(ctx, text) {
    const elapsed = Date.now() - ctx.startedAt;
    const expected = EXPECTED_DURATION_MS[ctx.job.type];
    // Asymptotic estimate: approaches 95% but never claims completion.
    const estimate = Math.round(5 + 90 * (1 - Math.exp(-elapsed / expected)));
    ctx.progress = Math.max(ctx.progress, Math.min(95, estimate));
    if (text) ctx.progressText = sanitize(String(text)).slice(0, 200);
  }

  async _writeProgress(ctx) {
    this._onProgress(ctx, null);
    const res = await Job.updateOne(
      this._executionFilter(ctx.job),
      { $set: { heartbeat_at: new Date(), progress: ctx.progress, progress_text: ctx.progressText } }
    ).catch(() => null);
    if (res && res.matchedCount === 0) {
      ctx.canceled = true;
      ctx.controller.abort(new Error('Job execution no longer owns this job.'));
    }
  }

  async _handleFailure(ctx, apiError) {
    if (this.stopping && ctx.controller.signal.aborted) return;
    const { job, lease } = ctx;
    const errorInfo = { code: apiError.code, message: sanitize(apiError.message).slice(0, 1000) };
    const guard = this._executionFilter(job);

    // Capacity race (slot taken between scheduling and acquisition) or node
    // shutting down: put the job back without consuming an attempt.
    if (apiError.code === 'capacity_exceeded' || apiError.code === 'service_shutting_down') {
      await Job.updateOne(guard, {
        $set: { status: 'queued', node_id: null, execution_id: null, progress: 0, progress_text: 'Waiting in queue', heartbeat_at: null },
        $inc: { attempts: -1 }
      }).catch(() => {});
      return;
    }

    const excluded = [...(job.excluded_accounts || []), ...(lease ? [lease.accountId] : [])];
    const retryable = isAccountLevelFailure(apiError)
      && job.attempts < job.max_attempts
      && !this.stopping
      && pool.hasAlternative(job.type, excluded);
    if (retryable) {
      const update = {
        $set: { status: 'queued', node_id: null, execution_id: null, account_id: null, progress: 0, progress_text: 'Retrying on another upstream account', heartbeat_at: null, last_attempt_error: errorInfo }
      };
      if (lease) update.$addToSet = { excluded_accounts: lease.accountId };
      const res = await Job.updateOne(guard, update).catch(() => null);
      if (res?.matchedCount) {
        log.warn({ job: job._id, attempt: job.attempts, code: apiError.code, account: lease?.accountId }, 'Job attempt failed; re-queued');
        return;
      }
    }

    // When every remaining account was already excluded, surface the error of
    // the previous attempt (more meaningful than "no accounts available").
    const finalError = apiError.code === 'no_accounts_available' && job.last_attempt_error?.code ? job.last_attempt_error : errorInfo;
    const updated = await Job.findOneAndUpdate(
      guard,
      { $set: { status: 'failed', completed_at: new Date(), progress_text: 'Failed', error: finalError } },
      { returnDocument: 'after' }
    ).lean().catch(() => null);
    if (updated) {
      log.warn({ job: job._id, code: finalError.code, attempts: job.attempts }, 'Job failed');
      this._finalize(updated);
    }
  }

  /** Post-terminal side effects: notify waiters, record usage, send webhook. */
  _finalize(doc) {
    const set = this.waiters.get(doc._id);
    if (set) for (const cb of [...set]) cb(doc);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    if (doc.status === 'succeeded') usage.track(doc.api_key_id, doc.type === 'video' ? 'videos' : 'images');
    if (doc.webhook?.url) {
      webhook.dispatchJobEvent(doc, serializeJob(doc)).catch((err) => log.warn({ job: doc._id, err: err.message }, 'Failed to queue webhook'));
    }
    this.emit('job-terminal', doc);
  }

  // ---------------------------------------------------------------------------
  // Maintenance sweeps
  // ---------------------------------------------------------------------------

  async _sweep() {
    const now = new Date();

    // 1. Queue deadline exceeded.
    const expiringTypes = JOB_TYPES.filter((type) => config.jobs[type].queueTimeoutMs > 0);
    const expired = expiringTypes.length
      ? await Job.find({ status: 'queued', type: { $in: expiringTypes }, queue_deadline: { $type: 'date', $lte: now } }).select('_id').limit(200).lean()
      : [];
    for (const { _id } of expired) {
      const doc = await Job.findOneAndUpdate(
        { _id, status: 'queued' },
        { $set: { status: 'failed', completed_at: now, progress_text: 'Failed', error: { code: ErrorCodes.QUEUE_TIMEOUT.code, message: ErrorCodes.QUEUE_TIMEOUT.message } } },
        { returnDocument: 'after' }
      ).lean();
      if (doc) this._finalize(doc);
    }

    // 2. Orphaned running jobs (owning node stopped heartbeating).
    const staleBefore = new Date(now.getTime() - config.jobs.heartbeatStaleMs);
    const orphans = await Job.find({ status: 'running', heartbeat_at: { $lt: staleBefore } }).limit(200).lean();
    for (const orphan of orphans) {
      if (orphan.node_id === this.nodeId && this.running.has(orphan._id)) continue;
      const guard = { _id: orphan._id, status: 'running', heartbeat_at: orphan.heartbeat_at, execution_id: orphan.execution_id ?? null };
      if (orphan.attempts < orphan.max_attempts) {
        await Job.updateOne(guard, {
          $set: { status: 'queued', node_id: null, execution_id: null, account_id: null, progress: 0, progress_text: 'Re-queued after interruption', heartbeat_at: null, last_attempt_error: { code: ErrorCodes.JOB_INTERRUPTED.code, message: 'The node processing this job stopped responding.' } }
        });
        log.warn({ job: orphan._id, ownerNode: orphan.node_id }, 'Recovered orphaned job; re-queued');
      } else {
        const doc = await Job.findOneAndUpdate(
          guard,
          { $set: { status: 'failed', completed_at: now, progress_text: 'Failed', error: { code: ErrorCodes.JOB_INTERRUPTED.code, message: ErrorCodes.JOB_INTERRUPTED.message } } },
          { returnDocument: 'after' }
        ).lean();
        if (doc) this._finalize(doc);
      }
    }

    await this._refreshPendingCount(true).catch(() => {});
  }

  /** Lightweight runtime stats (admin & metrics). */
  stats() {
    const running = { image: 0, video: 0 };
    for (const ctx of this.running.values()) running[ctx.job.type] += 1;
    return { node_id: this.nodeId, running, pending_global: this.pendingCount, stopping: this.stopping };
  }
}

async function withTimeout(promise, ms, message, controller) {
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  // The client acknowledges cancellation only after cleanup. Keep the lease
  // until that acknowledgement, rather than abandoning a Promise.race loser.
  try { return await promise; } finally { clearTimeout(timer); }
}

const dispatcher = new Dispatcher();

module.exports = { dispatcher, Dispatcher };

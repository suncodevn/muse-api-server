'use strict';

/**
 * Shared submission flow for generation endpoints (images & videos).
 *
 *  1. Idempotency replay check (before any expensive work).
 *  2. Admission control: capability available, global queue size, per-key
 *     concurrent job limit.
 *  3. Reference media normalization into stored files (early 4xx errors).
 *  4. Job persisted as "queued"; dispatcher picks it up.
 *  5. Async mode -> 202 Accepted + Location header.
 *     Sync mode  -> wait up to SYNC_WAIT_MAX_MS for completion; if the job is
 *     still running afterwards, fall back to 202 so clients can poll.
 */

const config = require('../config');
const { dispatcher } = require('../services/dispatcher');
const media = require('../services/media');
const webhook = require('../services/webhook');
const { serializeJob } = require('../serializers');
const { readIdempotencyKey, requestFingerprint } = require('./helpers');
const { ApiError, ErrorCodes } = require('../errors');

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

function sendAccepted(res, job, replayed) {
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.setHeader('Location', `/v1/jobs/${job._id}`);
  res.setHeader('Retry-After', job.type === 'video' ? '10' : '3');
  return res.status(202).json(serializeJob(job));
}

/** Converts a failed/canceled job into the matching API error. */
function terminalError(job) {
  if (job.status === 'canceled') {
    return new ApiError(ErrorCodes.JOB_NOT_COMPLETED, { message: `Job '${job._id}' was canceled before completion.`, details: { job_id: job._id } });
  }
  const err = ApiError.fromStored(job.error);
  err.details = { job_id: job._id };
  return err;
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} spec
 * @param {'image'|'video'} spec.type
 * @param {boolean} spec.sync                Wait for completion.
 * @param {object} spec.params               Job params (aspect_ratio, duration, response_format).
 * @param {{image?: string, images?: Array<{image: string, label: string, role: string}>, video?: string}} spec.references  Raw reference values.
 * @param {(job: object, res: object) => Promise<void>|void} spec.onSucceeded  Sync success renderer.
 */
async function submitGeneration(req, res, { type, sync, params, references, onSucceeded }) {
  const body = req.valid.body;
  const apiKey = req.auth.apiKey;
  const idempotencyKey = readIdempotencyKey(req);
  const fingerprint = idempotencyKey ? requestFingerprint(req) : null;

  let job = await dispatcher.findIdempotentJob(apiKey._id, idempotencyKey, fingerprint);
  let replayed = Boolean(job);

  if (!job) {
    await dispatcher.assertCanEnqueue(type, apiKey);
    const webhookUrl = body.webhook_url ? webhook.validateWebhookUrl(body.webhook_url) : null;

    const reference = { image_file_id: null, video_file_id: null };
    if (references.image) {
      const doc = await media.resolveReference(references.image, { expectedKind: 'image', apiKeyId: apiKey._id, param: 'reference_image' });
      reference.image_file_id = doc._id;
    }
    if (references.images) {
      reference.images = [];
      let totalBytes = 0;
      for (const [index, item] of references.images.entries()) {
        const doc = await media.resolveReference(item.image, { expectedKind: 'image', apiKeyId: apiKey._id, param: `reference_images.${index}.image` });
        totalBytes += doc.bytes;
        if (totalBytes > config.storage.maxImageBytes) {
          throw new ApiError(ErrorCodes.REFERENCE_INVALID, { message: 'Combined reference images exceed the image byte limit.', param: 'reference_images' });
        }
        reference.images.push({ file_id: doc._id, label: item.label, role: item.role });
      }
    }
    if (references.video) {
      const doc = await media.resolveReference(references.video, { expectedKind: 'video', apiKeyId: apiKey._id, param: 'reference_video' });
      reference.video_file_id = doc._id;
    }

    const created = await dispatcher.createJob({
      apiKey,
      type,
      prompt: body.prompt,
      params,
      reference,
      webhookUrl,
      idempotencyKey,
      fingerprint,
      metadata: body.metadata
    });
    job = created.job;
    replayed = created.replayed;
  }

  if (!sync) return sendAccepted(res, job, replayed);

  if (!TERMINAL.has(job.status)) {
    const waited = await dispatcher.waitForTerminal(job._id, config.jobs.syncWaitMaxMs);
    if (waited) job = waited;
  }
  if (res.writableEnded || req.socket?.destroyed) return undefined; // client went away

  if (!TERMINAL.has(job.status)) return sendAccepted(res, job, replayed);
  if (job.status !== 'succeeded') throw terminalError(job);
  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
  return onSucceeded(job, res);
}

module.exports = { submitGeneration, terminalError };

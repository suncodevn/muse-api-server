'use strict';

const mongoose = require('mongoose');
const { generateId } = require('../utils/crypto');

const JOB_TYPES = ['image', 'video'];
const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
const TERMINAL_STATUSES = ['succeeded', 'failed', 'canceled'];

/**
 * Durable generation job. MongoDB is the single source of truth for the queue,
 * which makes jobs survive restarts and allows multiple nodes to claim work
 * atomically (findOneAndUpdate on status = "queued").
 */
const JobSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateId('job') },
    type: { type: String, enum: JOB_TYPES, required: true },
    api_key_id: { type: String, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'queued' },
    prompt: { type: String, required: true, maxlength: 4000 },
    generation_session_id: { type: String, default: null },
    session_wait_until: { type: Date, default: null },
    params: {
      aspect_ratio: { type: String, default: null },
      duration: { type: Number, default: null },
      response_format: { type: String, default: 'url' }
    },
    reference: {
      image_file_id: { type: String, default: null },
      video_file_id: { type: String, default: null }
    },
    // Upstream accounts that already failed this job (skipped on retry).
    excluded_accounts: { type: [String], default: [] },
    account_id: { type: String, default: null },
    node_id: { type: String, default: null },
    execution_id: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    max_attempts: { type: Number, default: 2 },
    progress: { type: Number, default: 0, min: 0, max: 100 },
    progress_text: { type: String, default: null },
    output: {
      file_id: { type: String, default: null },
      mime_type: { type: String, default: null },
      bytes: { type: Number, default: null },
      text: { type: String, default: null }
    },
    error: {
      code: { type: String, default: null },
      message: { type: String, default: null }
    },
    // Failure of the previous attempt when the job was retried (internal diagnostics).
    last_attempt_error: {
      code: { type: String, default: null },
      message: { type: String, default: null }
    },
    webhook: {
      url: { type: String, default: null },
      delivered: { type: Boolean, default: false },
      attempts: { type: Number, default: 0 },
      last_status: { type: Number, default: null },
      last_error: { type: String, default: null },
      event_id: { type: String, default: null },
      body: { type: String, default: null },
      next_attempt_at: { type: Date, default: null },
      lease_token: { type: String, default: null },
      lease_until: { type: Date, default: null },
      abandoned: { type: Boolean, default: false }
    },
    idempotency_key: { type: String, default: null },
    request_fingerprint: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    // null means wait for capacity without a queue deadline.
    queue_deadline: { type: Date, default: null },
    heartbeat_at: { type: Date, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null }
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false }
);

// Dispatcher claim path: oldest queued job per type.
JobSchema.index({ status: 1, type: 1, created_at: 1 });
// Client listings & per-key concurrency counting.
JobSchema.index({ api_key_id: 1, created_at: -1 });
JobSchema.index({ api_key_id: 1, status: 1 });
// Orphan detection (stale heartbeats).
JobSchema.index({ status: 1, heartbeat_at: 1 });
JobSchema.index({ status: 1, 'webhook.delivered': 1, 'webhook.next_attempt_at': 1 });
// Idempotency: one job per (api key, idempotency key).
JobSchema.index(
  { api_key_id: 1, idempotency_key: 1 },
  { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } }
);

module.exports = {
  Job: mongoose.models.Job || mongoose.model('Job', JobSchema),
  JOB_TYPES,
  JOB_STATUSES,
  TERMINAL_STATUSES
};

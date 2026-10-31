'use strict';

/**
 * Public resource representations.
 *
 * Internal documents are never returned directly. Each resource has an explicit
 * shape with an `object` discriminator, ISO-8601 UTC timestamps and no
 * internal/sensitive fields, so the database schema can evolve without
 * breaking API consumers.
 */

const { createSignedUrl } = require('./services/storage');
const { maskCredential } = require('./core/credentials');

const iso = (d) => (d ? new Date(d).toISOString() : null);

function serializeFile(doc) {
  return {
    id: doc._id,
    object: 'file',
    purpose: doc.purpose,
    kind: doc.kind,
    mime_type: doc.mime_type,
    bytes: doc.bytes,
    filename: doc.filename || null,
    sha256: doc.sha256,
    created_at: iso(doc.created_at),
    expires_at: iso(doc.expires_at)
  };
}

function serializeJob(doc) {
  let output = null;
  if (doc.status === 'succeeded' && doc.output?.file_id) {
    const signed = createSignedUrl(doc.output.file_id);
    output = {
      file_id: doc.output.file_id,
      url: signed.url,
      url_expires_at: signed.expires_at,
      mime_type: doc.output.mime_type,
      bytes: doc.output.bytes,
      text: doc.output.text || null
    };
  }
  return {
    id: doc._id,
    object: 'job',
    type: doc.type,
    generation_session_id: doc.generation_session_id || null,
    status: doc.status,
    progress: doc.progress ?? 0,
    progress_text: doc.progress_text || null,
    prompt: doc.prompt,
    params: {
      aspect_ratio: doc.params?.aspect_ratio || null,
      ...(doc.type === 'video' ? { duration: doc.params?.duration ?? null } : { response_format: doc.params?.response_format || 'url' })
    },
    reference: {
      image_file_id: doc.reference?.image_file_id || null,
      ...(doc.reference?.images?.length ? { images: doc.reference.images.map(item => ({ file_id: item.file_id, label: item.label, role: item.role })) } : {}),
      ...(doc.type === 'video' ? { video_file_id: doc.reference?.video_file_id || null } : {})
    },
    output,
    error: doc.error?.code ? { code: doc.error.code, message: doc.error.message } : null,
    attempts: doc.attempts || 0,
    webhook: doc.webhook?.url ? { url: doc.webhook.url, delivered: Boolean(doc.webhook.delivered), attempts: doc.webhook.attempts || 0 } : null,
    metadata: doc.metadata || {},
    created_at: iso(doc.created_at),
    started_at: iso(doc.started_at),
    completed_at: iso(doc.completed_at)
  };
}

function serializeAccount(doc, live = null) {
  return {
    id: doc._id,
    object: 'account',
    name: doc.name,
    enabled: doc.enabled,
    status: live?.status || doc.status,
    group: doc.group || '',
    credential_type: doc.credential_type,
    credential_preview: doc.credential ? maskCredential(doc.credential) : undefined,
    wss_expires_at: iso(doc.wss_expires_at),
    has_proxy: Boolean(doc.proxy),
    capabilities: { chat: doc.capabilities?.chat !== false, image: doc.capabilities?.image !== false, video: doc.capabilities?.video !== false },
    concurrency: {
      chat: doc.concurrency?.chat ?? null,
      image: doc.concurrency?.image ?? null,
      video: doc.concurrency?.video ?? null
    },
    live: live
      ? {
          connected: live.connected,
          is_renewing: Boolean(live.is_renewing),
          active: live.active,
          limits: live.limits,
          consecutive_failures: live.consecutive_failures,
          cooldown_until: live.cooldown_until
        }
      : null,
    last_error: doc.last_error?.code ? { code: doc.last_error.code, message: doc.last_error.message, at: iso(doc.last_error.at) } : null,
    last_connected_at: iso(doc.last_connected_at),
    stats: { requests: doc.stats?.requests || 0, failures: doc.stats?.failures || 0 },
    metadata: doc.metadata || {},
    created_at: iso(doc.created_at),
    updated_at: iso(doc.updated_at)
  };
}

function serializeApiKey(doc) {
  return {
    id: doc._id,
    object: 'api_key',
    name: doc.name,
    key_prefix: doc.key_prefix,
    scopes: doc.scopes,
    enabled: doc.enabled,
    expires_at: iso(doc.expires_at),
    rate_limit_per_minute: doc.rate_limit_per_minute ?? null,
    max_concurrent_jobs: doc.max_concurrent_jobs ?? null,
    usage: {
      requests: doc.usage?.requests || 0,
      chat_completions: doc.usage?.chat_completions || 0,
      images: doc.usage?.images || 0,
      videos: doc.usage?.videos || 0
    },
    last_used_at: iso(doc.last_used_at),
    metadata: doc.metadata || {},
    created_at: iso(doc.created_at),
    updated_at: iso(doc.updated_at)
  };
}

function serializeConversation(doc) {
  return {
    id: doc._id,
    object: 'conversation',
    title: doc.title || null,
    message_count: doc.message_count || 0,
    last_message_at: iso(doc.last_message_at),
    metadata: doc.metadata || {},
    created_at: iso(doc.created_at),
    updated_at: iso(doc.updated_at)
  };
}

/** Standard cursor-paginated list envelope. */
function list(data, { hasMore = false, url }) {
  return {
    object: 'list',
    url,
    data,
    has_more: hasMore,
    next_cursor: hasMore && data.length ? data[data.length - 1].id : null
  };
}

module.exports = { serializeFile, serializeJob, serializeAccount, serializeApiKey, serializeConversation, list, iso };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const logger = { child: () => ({ info() {}, warn() {}, error() {} }) };
const cryptoUtils = require('../src/utils/crypto');
class ApiError extends Error {
  constructor(def = {}, options = {}) { super(options.message || def.message || def.code); Object.assign(this, def, options); }
}
const ErrorCodes = new Proxy({}, { get: (_, key) => ({ code: key.toLowerCase(), message: key.toLowerCase() }) });
const errors = { ApiError, ErrorCodes, classifyUpstreamError: e => e instanceof ApiError ? e : new ApiError(ErrorCodes.UPSTREAM_ERROR, { message: e.message }), isAccountLevelFailure: e => e.code?.startsWith('upstream') };
const config = {
  pool: { defaultConcurrency: { chat: 4, image: 2, video: 1 }, chatSlotWaitMs: 0 },
  server: { nodeId: 'test-node', shutdownGraceMs: 0 },
  storage: { allowRemoteUrls: true, maxImageBytes: 20 * 1024 * 1024, maxVideoBytes: 100 * 1024 * 1024, remoteFetchTimeoutMs: 1000 },
  jobs: { maxPendingGlobal: 2000, maxAttempts: 2, heartbeatStaleMs: 90000, image: { timeoutMs: 1000, queueTimeoutMs: 1000 }, video: { timeoutMs: 1000, queueTimeoutMs: 1000 } },
  rateLimit: { defaultMaxConcurrentJobs: 20 },
  webhooks: { timeoutMs: 1000, maxAttempts: 5, allowPrivateTargets: true },
  isProduction: false
};

function isolated(relative, mocks = {}, suffix = '', globals = {}) {
  const filename = path.join(root, relative);
  const context = {
    module: { exports: {} }, Buffer, TextEncoder, TextDecoder, Uint8Array, AbortController, URL,
    console: { log() {}, warn() {}, error() {} }, process: { env: {} },
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, ...globals,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id === '../config') return config;
      if (id === '../logger') return { logger, sanitize: x => x };
      if (id === '../errors') return errors;
      if (id === '../utils/crypto') return cryptoUtils;
      if (id.startsWith('.')) return require(path.resolve(path.dirname(filename), id));
      return require(id);
    }
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + suffix, context, { filename });
  return context.module.exports;
}

const A = '11111111-1111-4111-a111-111111111111';
const B = '22222222-2222-4222-a222-222222222222';
function client(globals = {}) {
  const { MuseClient } = isolated('src/core/client.js', {}, '', globals);
  return new MuseClient({ cookies: 'test' });
}

test('concurrent frames are sent in nonce order; synchronous responses are registered', async () => {
  const c = client();
  let nonce = 0;
  const sent = [];
  c.sendCipher = { encryptWithAd: async () => {
    const n = nonce++;
    await delay(n === 0 ? 25 : 1);
    return n;
  } };
  c.ws = { readyState: 1, send(n, callback) {
    sent.push(n);
    const key = String(n + 1);
    c.pendingStreams.get(key).resolve({ status: 200 });
    c.pendingStreams.delete(key);
    callback();
  } };
  const responses = await Promise.all([c.sendRequest('POST', '/a'), c.sendRequest('POST', '/b')]);
  assert.deepEqual(sent, [0, 1]);
  assert.equal(responses.length, 2);
  assert.equal(c.pendingStreams.size, 0);
});

test('chat isolates both session_id and chat_context.chat_id and ignores unscoped events', async () => {
  const c = client({ setTimeout: (fn, ms) => setTimeout(fn, ms === 3500 ? 1 : ms) });
  c.sendRequest = async () => ({ status: 200, body: '{}' });
  const pa = c.chat('a', { sessionId: A, timeout: 1000 });
  const pb = c.chat('b', { sessionId: B, timeout: 1000 });
  c.emit('text_delta', 'secret A', { chat_context: { chat_id: A } }, 1);
  c.emit('text_delta', 'secret B', { session_id: B }, 2);
  c.emit('text_delta', 'unscoped', {}, 3);
  c.emit('presentation', { kind: 'image', session_id: A, image_path: 'a.png' }, 4);
  for (const id of [A, B]) {
    c.emit('event', { event: 'sessions.updated', session_id: id, payload: { session: { status: 'completed' }, change: 'updated' } });
    c.emit('agent_status', { session_id: id, activity_code: 'idle' }, 5);
  }
  const [a, b] = await Promise.all([pa, pb]);
  assert.equal(a.text, 'secret A');
  assert.equal(b.text, 'secret B');
  assert.equal(a.presentations.length, 1);
  assert.equal(b.presentations.length, 0);
  assert.equal(c.listenerCount('text_delta'), 0);
});

test('aborted chat waits for session cleanup and retains egress guard during cleanup', async () => {
  const c = client();
  const controller = new AbortController();
  c.ws = { readyState: 1 };
  c.sendRequest = async () => ({ status: 200, body: '{}' });
  let deleted = false;
  c.deleteSession = async id => { assert.equal(id, A); await delay(20); deleted = true; return { ok: true }; };
  const p = c.chat('a', { sessionId: A, signal: controller.signal, guardEgress: true });
  const rejected = assert.rejects(p, /cancel test/);
  controller.abort(new Error('cancel test'));
  assert.equal(c.guardedSessions.has(A), true);
  await rejected;
  assert.equal(deleted, true);
  assert.equal(c.guardedSessions.size, 0);
  assert.equal(c.listenerCount('event'), 0);
});

test('chat timeout cancels a partially streamed turn instead of releasing live upstream work', async () => {
  const c = client();
  c.ws = { readyState: 1 };
  c.sendRequest = async () => ({ status: 200, body: '{}' });
  let deleted = false;
  c.deleteSession = async () => { await delay(10); deleted = true; return { ok: true }; };
  const p = c.chat('prompt', { sessionId: A, timeout: 10 });
  c.emit('text_delta', 'partial response', { session_id: A }, 1);
  await assert.rejects(p, /timed out/);
  assert.equal(deleted, true);
  assert.equal(c.listenerCount('text_delta'), 0);
});

test('video with no presentation cannot use another session workspace output', async () => {
  const c = client();
  c.chat = async () => ({ text: 'not generated', presentations: [], sessionId: A });
  c.deleteSession = async () => ({ ok: true });
  c.sendRequest = async () => { throw new Error('Must not scan shared workspace'); };
  const result = await c.generateVideo('new request');
  assert.equal(result.success, false);
});

test('image and video generation preserve references, options and session-owned output', async () => {
  for (const kind of ['image', 'video']) {
    const c = client();
    const controller = new AbortController();
    const reference = { data_base64: 'abc', mime_type: 'image/png' };
    c.chat = async (prompt, options) => {
      assert.equal(options.waitForKind, kind);
      assert.equal(options.ref_image, reference);
      assert.equal(options.signal, controller.signal);
      assert.match(prompt, /16:9/);
      return { text: 'generated', sessionId: A, presentations: [{ kind, data: { [kind === 'image' ? 'images' : 'videos']: [{ path: 'own-output', mime: `${kind}/test` }] } }] };
    };
    c.readFile = async (p, limit, options) => { assert.equal(p, 'own-output'); assert.equal(limit, 123); assert.equal(options.signal, controller.signal); return Buffer.from('complete'); };
    let cleaned = false;
    c.deleteSession = async () => { cleaned = true; return { ok: true }; };
    const result = await c[kind === 'image' ? 'generateImage' : 'generateVideo']('prompt', { ref_image: reference, aspect_ratio: '16:9', maxBytes: 123, signal: controller.signal });
    assert.equal(result.success, true);
    assert.equal(result.buffer.toString(), 'complete');
    assert.equal(cleaned, true);
  }
});

test('downloads reject overflow, allow exact EOF, and clean sessions on download failure', async () => {
  const c = client();
  c.sendRequest = async () => ({ status: 200, body: JSON.stringify({ ok: true, result: { data_base64: Buffer.alloc(8).toString('base64'), eof: false, len: 8 } }) });
  await assert.rejects(c.readFile('large.mp4', 16), /download limit/);
  c.sendRequest = async () => ({ status: 200, body: JSON.stringify({ ok: true, result: { data_base64: Buffer.alloc(16).toString('base64'), eof: true, len: 16 } }) });
  assert.equal((await c.readFile('exact.mp4', 16)).length, 16);
  c.chat = async () => ({ text: '', sessionId: A, presentations: [{ kind: 'video', data: { videos: [{ path: 'bad.mp4' }] } }] });
  c.readFile = async () => { throw new Error('download failed'); };
  let deleted = false;
  c.deleteSession = async () => { deleted = true; return { ok: true }; };
  await assert.rejects(c.generateVideo('prompt'), /download failed/);
  assert.equal(deleted, true);
});

test('cookie renewal during connect is single-flight and does not wait on itself', async () => {
  let renews = 0;
  let connects = 0;
  class Client extends EventEmitter {
    constructor() { super(); this.ws = { readyState: 1 }; }
    async connect() { connects++; }
    writeFile() { return Promise.resolve(); }
  }
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } },
    '../core/client': { MuseClient: Client, fetchWssFromCookie: async () => { renews++; await delay(5); return { hybrid: 'fresh', wsUrl: 'wss://test' }; } },
    '../core/credentials': { describeCredential: value => ({ type: 'hybrid', has_cookie: true, cookie: 'cookie', has_wss: true, wss_expired: value !== 'fresh' }), buildHybrid: () => '' }
  });
  const pool = new AccountPool();
  const entry = pool._upsertEntry({ _id: 'acct', enabled: true, credential: 'expired' });
  const timeout = setTimeout(() => { assert.fail('Renewal deadlocked'); }, 500);
  try {
    const [a, b] = await Promise.all([pool._ensureClient(entry), pool.autoRenewAccount(entry)]);
    assert.equal(a, b.client);
    assert.equal(renews, 1);
    assert.equal(connects, 1);
    assert.equal(entry.connecting, null);
    assert.equal(entry.isRenewing, null);
  } finally { clearTimeout(timeout); }
});

test('authentication failure renews the credential and reconnects without recursive connection waits', async () => {
  let connects = 0;
  let renews = 0;
  class Client extends EventEmitter {
    constructor() { super(); this.ws = { readyState: 1 }; }
    async connect() { if (++connects === 1) throw Object.assign(new Error('expired'), { code: 'MUSE_AUTH_EXPIRED' }); }
    writeFile() { return Promise.resolve(); }
    close() { this.ws = null; }
  }
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } },
    '../core/client': { MuseClient: Client, fetchWssFromCookie: async () => { renews++; return { hybrid: 'fresh', wsUrl: 'wss://test' }; } },
    '../core/credentials': { describeCredential: () => ({ type: 'hybrid', has_cookie: true, cookie: 'cookie', has_wss: true, wss_expired: false }), buildHybrid: () => '' }
  });
  const pool = new AccountPool();
  const entry = pool._upsertEntry({ _id: 'acct', enabled: true, credential: 'valid-looking' });
  const connected = await pool._ensureClient(entry);
  assert.equal(connected.ws.readyState, 1);
  assert.equal(connects, 2);
  assert.equal(renews, 1);
});

function dispatcher(mocks = {}, globals = {}) {
  return isolated('src/services/dispatcher.js', {
    '../models': {}, './pool': { pool: {} }, './storage': {}, './media': {}, './generationSessions': {}, './usage': { track() {} },
    './webhook': { startWebhooks() {}, stopWebhooks() {}, dispatchJobEvent: async () => {} },
    '../serializers': { serializeJob: x => x }, ...mocks
  }, '', globals).Dispatcher;
}

function slotPool() {
  const { AccountPool } = isolated('src/services/pool.js', {
    '../models': { CAPABILITIES: ['chat', 'image', 'video'], Account: { updateOne: async () => ({}) } }
  });
  const pool = new AccountPool();
  for (const id of ['account-1', 'account-2']) {
    pool._upsertEntry({ _id: id, enabled: true, credential: 'test', concurrency: { chat: 1, image: 1, video: 1 } });
  }
  pool._ensureClient = async () => ({ ws: { readyState: 1 } });
  return pool;
}

test('chat, image and video skip full accounts and wait FIFO until any account has a slot', async () => {
  for (const capability of ['chat', 'image', 'video']) {
    const pool = slotPool();
    const a = await pool.acquire(capability);
    const b = await pool.acquire(capability);
    assert.equal(a.accountId, 'account-1');
    assert.equal(b.accountId, 'account-2');
    assert.equal(pool.availableSlots(capability), 0);
    let firstStarted = false;
    let secondStarted = false;
    const first = pool.acquire(capability, { waitMs: null }).then(lease => { firstStarted = true; return lease; });
    const second = pool.acquire(capability, { waitMs: null }).then(lease => { secondStarted = true; return lease; });
    await delay(5);
    assert.equal(firstStarted, false);
    assert.equal(secondStarted, false);
    b.release();
    const c = await first;
    assert.equal(c.accountId, 'account-2');
    assert.equal(secondStarted, false);
    a.release();
    const d = await second;
    assert.equal(d.accountId, 'account-1');
    c.release(); d.release();
    assert.equal(pool.availableSlots(capability), 2);
    assert.equal(pool.waiters[capability].length, 0);
  }
});

test('disconnect removes a queued chat request without occupying or leaking a slot', async () => {
  const pool = slotPool();
  const a = await pool.acquire('chat');
  const b = await pool.acquire('chat');
  const controller = new AbortController();
  const pending = pool.acquire('chat', { waitMs: null, signal: controller.signal });
  const rejection = assert.rejects(pending, /disconnect/);
  await delay(1);
  assert.equal(pool.waiters.chat.length, 1);
  controller.abort(new Error('disconnect'));
  await rejection;
  assert.equal(pool.waiters.chat.length, 0);
  a.release(); b.release();
  assert.equal(pool.availableSlots('chat'), 2);
});

test('dispatcher fills both accounts, leaves additional videos queued, then dispatches on release', async () => {
  const pool = slotPool();
  const rows = Array.from({ length: 3 }, (_, i) => ({
    _id: `job_${i}`, type: 'video', prompt: `prompt-${i}`, status: 'queued', api_key_id: 'key',
    excluded_accounts: [], attempts: 0, max_attempts: 2, queue_deadline: new Date(0)
  }));
  const completions = new Map();
  const starts = [];
  pool._ensureClient = async entry => ({ ws: { readyState: 1 }, generateVideo: prompt => {
    starts.push({ prompt, account: entry.id });
    return new Promise(resolve => completions.set(prompt, resolve));
  } });
  const Job = {
    findOneAndUpdate(filter, update) { return { lean: async () => {
      const row = rows.find(j => j.status === filter.status && (!filter._id || j._id === filter._id) && (!filter.execution_id || j.execution_id === filter.execution_id) && (!filter.queue_deadline?.$gt || j.queue_deadline > filter.queue_deadline.$gt));
      if (!row) return null;
      Object.assign(row, update.$set);
      if (update.$inc) row.attempts += update.$inc.attempts || 0;
      return structuredClone(row);
    } }; },
    async updateOne(filter, update) {
      const row = rows.find(j => j._id === filter._id && j.status === filter.status && j.execution_id === filter.execution_id);
      if (!row) return { matchedCount: 0 };
      Object.assign(row, update.$set);
      return { matchedCount: 1 };
    }
  };
  const Dispatcher = dispatcher({
    '../config': { ...config, jobs: { ...config.jobs, video: { ...config.jobs.video, queueTimeoutMs: 0 } } },
    '../models': { Job }, './pool': { pool },
    './storage': { saveFile: async () => ({ _id: 'output' }), deleteFile: async () => {} }
  });
  const d = new Dispatcher();
  d._loadReferences = async () => ({});
  d.kick = () => {};
  d._finalize = () => {};
  await d._tick();
  await delay(5);
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts.map(s => s.account)), new Set(['account-1', 'account-2']));
  assert.equal(rows[2].status, 'queued');
  assert.equal(rows[2].attempts, 0);
  await d._tick();
  assert.equal(starts.length, 2);
  completions.get('prompt-0')({ success: true, buffer: Buffer.from('video') });
  await delay(5);
  await d._tick();
  await delay(5);
  assert.equal(starts.length, 3);
  assert.equal(starts[2].account, starts[0].account);
  assert.equal(rows[2].status, 'running');
  completions.get('prompt-1')({ success: true, buffer: Buffer.from('video') });
  completions.get('prompt-2')({ success: true, buffer: Buffer.from('video') });
  await delay(5);
  assert.ok(rows.every(j => j.status === 'succeeded'));
  assert.equal(pool.availableSlots('video'), 2);
  assert.equal(d.running.size, 0);
});

test('job execution updates are fenced by a distinct token for every claim', async () => {
  const claims = [];
  const Dispatcher = dispatcher({ '../models': { Job: { findOneAndUpdate: (filter, update) => ({ lean: async () => { claims.push(update.$set); return { _id: 'job', ...update.$set }; } }) } } });
  const d = new Dispatcher();
  const a = await d._claim('image');
  const b = await d._claim('image');
  assert.notEqual(a.execution_id, b.execution_id);
  assert.equal(d._executionFilter(a).execution_id, a.execution_id);
  assert.equal(d._executionFilter(b).execution_id, b.execution_id);
});

test('retry exclusions do not prevent fresh queued jobs from using an available account', async () => {
  const pool = slotPool();
  const occupied = await pool.acquire('video');
  const rows = [
    { _id: 'retry', excluded_accounts: ['account-2'] },
    { _id: 'fresh', excluded_accounts: [] }
  ];
  const Dispatcher = dispatcher({
    '../models': { Job: { findOneAndUpdate: filter => ({ lean: async () => rows.find(j => !filter.$nor?.some(rule => rule.excluded_accounts.$all.every(id => j.excluded_accounts.includes(id)))) }) } },
    './pool': { pool }
  });
  const d = new Dispatcher();
  assert.equal((await d._claim('video'))._id, 'fresh');
  occupied.release();
});

test('job timeout holds its slot until generation acknowledges abort and finishes cleanup', async () => {
  let cleaned = false;
  let released = false;
  const lease = { accountId: 'acct', released: false, release() {
    assert.equal(cleaned, true);
    released = true; this.released = true;
  }, client: { generateImage: (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', async () => { await delay(20); cleaned = true; reject(signal.reason); }, { once: true });
  }) } };
  const Dispatcher = dispatcher({
    '../models': { Job: {
      updateOne: async () => ({ matchedCount: 1 }),
      findOneAndUpdate: () => ({ lean: async () => ({ _id: 'job', status: 'failed', api_key_id: 'key' }) })
    } },
    './pool': { pool: { acquire: async () => lease, hasAlternative: () => false } }
  }, { setTimeout: (fn, ms) => setTimeout(fn, ms === 61000 ? 5 : ms) });
  const d = new Dispatcher();
  d._loadReferences = async () => ({});
  d._finalize = () => {};
  const running = d._run({ _id: 'job', type: 'image', execution_id: 'run-a', api_key_id: 'key', attempts: 1, max_attempts: 2 });
  await delay(10);
  assert.equal(released, false);
  await running;
  assert.equal(cleaned, true);
  assert.equal(released, true);
  assert.equal(d.running.size, 0);
});

test('an old job execution cannot commit output or remove the newer execution context', async () => {
  let currentRun = 'run-a';
  let finish;
  let started;
  const ready = new Promise(r => { started = r; });
  let discarded = 0;
  const lease = { accountId: 'acct', released: false, release() { this.released = true; }, client: {
    generateImage: () => { started(); return new Promise(r => { finish = r; }); }
  } };
  const Dispatcher = dispatcher({
    '../models': { Job: {
      updateOne: async f => ({ matchedCount: f.execution_id === currentRun ? 1 : 0 }),
      findOneAndUpdate: f => ({ lean: async () => { assert.notEqual(f.execution_id, currentRun); return null; } })
    } },
    './pool': { pool: { acquire: async () => lease } },
    './storage': { saveFile: async () => ({ _id: 'file' }), deleteFile: async () => { discarded++; } }
  });
  const d = new Dispatcher();
  d._loadReferences = async () => ({});
  const running = d._run({ _id: 'job', type: 'image', execution_id: 'run-a', api_key_id: 'key' });
  await ready;
  currentRun = 'run-b';
  const newer = { job: { type: 'image' } };
  d.running.set('job', newer);
  finish({ success: true, buffer: Buffer.from('output') });
  await running;
  assert.equal(discarded, 1);
  assert.equal(d.running.get('job'), newer);
});

test('admin cancellation uses the normal terminal notification path', async () => {
  let filter;
  const canceled = { _id: 'job', status: 'canceled' };
  const Dispatcher = dispatcher({ '../models': { Job: { findOneAndUpdate: f => { filter = f; return { lean: async () => canceled }; } } } });
  const d = new Dispatcher();
  const ctx = { controller: new AbortController() };
  d.running.set('job', ctx);
  let finalized;
  d._finalize = doc => { finalized = doc; };
  await d.cancel('job', null, { admin: true });
  assert.equal(Object.hasOwn(filter, 'api_key_id'), false);
  assert.equal(finalized, canceled);
  assert.equal(ctx.controller.signal.aborted, true);
});

test('live queue capacity setting is used by admission control without billing/quota writes', async () => {
  const Dispatcher = dispatcher({
    '../models': { Job: { countDocuments: async () => 0 } },
    './pool': { pool: { hasCapability: () => true } }
  });
  const d = new Dispatcher();
  d._refreshPendingCount = async () => 11;
  d.setMaxPendingGlobal(10);
  await assert.rejects(d.assertCanEnqueue('image', { _id: 'key' }), /queue_full/);
  d.setMaxPendingGlobal(12);
  await d.assertCanEnqueue('image', { _id: 'key' });
});

test('redirect to a literal private IP is blocked before connecting', async () => {
  let redirected = false;
  const media = isolated('src/services/media.js', {
    axios: { get: async (_, options) => {
      redirected = true;
      try { options.beforeRedirect({ href: 'http://127.0.0.1/private' }); }
      catch (err) { throw Object.assign(new Error('redirect failed'), { cause: err }); }
      throw new Error('Private redirect was allowed');
    } },
    './storage': {}, '../utils/net': require('../src/utils/net')
  });
  await assert.rejects(media.resolveReference('https://public.example/image.png', { expectedKind: 'image', apiKeyId: 'key', param: 'reference_image' }), /reference_url_forbidden/);
  assert.equal(redirected, true);
});

test('actual Axios redirect handling never requests the private redirect destination', async () => {
  const http = require('node:http');
  let privateRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/private` });
      res.end();
    } else { privateRequests++; res.end('private'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const agent = new http.Agent({ family: 4 });
  const media = isolated('src/services/media.js', {
    './storage': {}, '../utils/net': { ...require('../src/utils/net'), safeHttpAgent: agent }
  });
  try {
    await assert.rejects(media.resolveReference(`http://localhost:${server.address().port}/start`, { expectedKind: 'image', apiKeyId: 'key', param: 'reference_image' }), err => {
      assert.equal(err.code, 'reference_url_forbidden');
      return true;
    });
    assert.equal(privateRequests, 0);
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('webhook retries survive worker reload with the same event ID, body and signature', async () => {
  const job = { _id: 'job', status: 'succeeded', api_key_id: 'key', completed_at: new Date(), webhook: { url: 'http://receiver.test', attempts: 0 } };
  const calls = [];
  function setFields(update) {
    for (const [key, value] of Object.entries(update.$set || {})) job.webhook[key.slice(8)] = value;
    if (update.$inc) job.webhook.attempts += update.$inc['webhook.attempts'];
  }
  const Job = {
    findOneAndUpdate(filter, update) { return { lean: async () => {
      if (job.webhook.delivered || job.webhook.abandoned || job.webhook.lease_until > new Date() || job.webhook.next_attempt_at > new Date()) return null;
      setFields(update); return structuredClone(job);
    } }; },
    async updateOne(filter, update) {
      if (filter['webhook.lease_token'] !== job.webhook.lease_token) return { matchedCount: 0 };
      setFields(update); return { matchedCount: 1 };
    }
  };
  const mocks = {
    '../models': { Job, ApiKey: { findById: () => ({ select: () => ({ lean: async () => ({ webhook_secret: 'secret' }) }) }) } },
    '../serializers': { serializeJob: j => ({ id: j._id, status: j.status }) },
    '../utils/net': { ...require('../src/utils/net'), isLiteralPrivateHost: () => false },
    axios: { post: async (url, body, options) => { calls.push({ body, headers: options.headers }); return { status: calls.length === 1 ? 500 : 200 }; } }
  };
  const first = isolated('src/services/webhook.js', mocks);
  first.startWebhooks();
  await first.drainWebhooks();
  first.stopWebhooks();
  assert.equal(job.webhook.attempts, 1);
  assert.ok(job.webhook.next_attempt_at);
  job.webhook.next_attempt_at = new Date(0);
  const restarted = isolated('src/services/webhook.js', mocks);
  restarted.startWebhooks();
  await restarted.drainWebhooks();
  restarted.stopWebhooks();
  assert.equal(job.webhook.delivered, true);
  assert.equal(job.webhook.attempts, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['X-Webhook-Id'], calls[1].headers['X-Webhook-Id']);
  assert.equal(calls[1].headers['X-Webhook-Signature'], restarted.sign('secret', calls[1].headers['X-Webhook-Timestamp'], calls[1].body));
});

test('real Express routes retain health, docs, authentication and validation contracts', async () => {
  // Supply test values before loading config so its secret fallback never writes .env.
  process.env.ADMIN_API_KEY = 'internal-test-admin-key-32-characters';
  process.env.SIGNING_SECRET = 'internal-test-signing-secret-32-characters';
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/architecture_test';
  process.env.LOG_LEVEL = 'silent';
  const http = require('node:http');
  const { createApp } = require('../src/app');
  const server = http.createServer(createApp());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    assert.ok(health.headers.get('x-request-id'));
    const spec = await fetch(`${base}/openapi.json`);
    assert.equal((await spec.json()).openapi, '3.1.0');
    const docs = await fetch(`${base}/docs`);
    assert.match(await docs.text(), /SwaggerUIBundle/);
    const unauthenticated = await fetch(`${base}/v1/jobs`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.code, 'api_key_missing');
    const invalid = await fetch(`${base}/v1/images/generations`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}`, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'validation_failed');

    // /admin/index.html must require dashboard authentication (redirect to /admin/login)
    const adminIndex = await fetch(`${base}/admin/index.html`, { redirect: 'manual' });
    assert.equal(adminIndex.status, 302);
    assert.match(adminIndex.headers.get('location') || '', /^\/admin\/login/);

    // Random unauthenticated /v1/* paths must collapse to route="unmatched" in /metrics
    await fetch(`${base}/v1/random-probe-${Date.now()}`);
    const metricsRes = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` }
    });
    assert.equal(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert.equal(metricsText.includes('random-probe-'), false);
    assert.equal(metricsText.includes('route="unmatched"'), true);
  } finally {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
});

test('NoiseFrameDecoder evicts stale or excessive partial frames and serializeAccount exposes is_renewing', () => {
  const { NoiseFrameDecoder } = require('../src/core/proto');
  const decoder = new NoiseFrameDecoder();
  for (let i = 0; i < 300; i++) {
    decoder.decode(i, 0, 2, new Uint8Array([1]));
  }
  assert.ok(decoder.pending.size <= 256);

  const { serializeAccount } = require('../src/serializers');
  const serialized = serializeAccount(
    { _id: 'acct_1', name: 'Worker 1', enabled: true, status: 'degraded', credential_type: 'cookie' },
    { status: 'degraded', connected: false, is_renewing: true, active: { chat: 0, image: 0, video: 0 }, limits: { chat: 4, image: 2, video: 1 }, consecutive_failures: 1, cooldown_until: null }
  );
  assert.equal(serialized.live.is_renewing, true);
});

test('retained image/video turns use the supplied upstream session and never delete it on success', async () => {
  for (const kind of ['image', 'video']) {
    const c = client();
    c.chat = async (_, options) => {
      assert.equal(options.sessionId, A);
      assert.equal(options.new_session, false);
      return { sessionId: A, text: 'done', presentations: [{ kind, data: { [kind === 'image' ? 'images' : 'videos']: [{ path: `${kind}.bin` }] } }] };
    };
    c.readFile = async () => Buffer.from('media');
    c.deleteSession = async () => assert.fail('Retained session was deleted');
    const result = await c[kind === 'image' ? 'generateImage' : 'generateVideo']('next turn', { sessionId: A, retainSession: true });
    assert.equal(result.sessionId, A);
    assert.equal(result.success, true);
  }
});

test('generation sessions enforce ownership, atomic exclusivity, account affinity and uncertainty', async () => {
  const doc = { _id: 'gs_test', api_key_id: 'owner', session_id: A, account_id: null, state: 'ready', active_execution: null, turn_count: 0 };
  function matches(filter) {
    return Object.entries(filter).every(([key, value]) => key === '$or' ? value.some(matches) : doc[key] === value);
  }
  function update(changes) { Object.assign(doc, changes.$set || {}); for (const [key, n] of Object.entries(changes.$inc || {})) doc[key] += n; }
  const model = {
    findOne: filter => ({ lean: async () => matches(filter) ? { ...doc } : null }),
    findOneAndUpdate: (filter, changes) => ({ lean: async () => { if (!matches(filter)) return null; update(changes); return { ...doc }; } }),
    updateOne: async (filter, changes) => { if (!matches(filter)) return { matchedCount: 0 }; update(changes); return { matchedCount: 1 }; }
  };
  const sessions = isolated('src/services/generationSessions.js', { '../models/GenerationSession': { GenerationSession: model } });
  const job = { _id: 'job_one', api_key_id: 'owner', generation_session_id: 'gs_test', execution_id: 'run_one' };
  await assert.rejects(sessions.get('gs_test', 'foreign'), /resource_not_found/);
  const [first, second] = await Promise.allSettled([sessions.lock(job), sessions.lock({ ...job, execution_id: 'run_two' })]);
  assert.equal(first.status, 'fulfilled'); assert.equal(second.status, 'rejected');
  await sessions.bind(job, 'account_one');
  await assert.rejects(sessions.bind(job, 'account_two'), /conversation_unavailable/);
  await sessions.finish({ ...job, execution_id: 'foreign_execution' }, true);
  assert.equal(doc.active_execution, 'run_one');
  await sessions.finish(job, true);
  assert.equal(doc.turn_count, 1);assert.equal(doc.active_execution, null);assert.equal(doc.state, 'ready');
  await sessions.lock(job);await sessions.bind(job, 'account_one');await sessions.finish(job, false);
  assert.equal(doc.state, 'uncertain');
  await assert.rejects(sessions.get('gs_test', 'owner'), /uncertain upstream turn/);
  const publicDoc = sessions.serialize(doc);
  assert.equal(publicDoc.session_id, undefined);assert.equal(publicDoc.account_id, undefined);assert.equal(publicDoc.api_key_id, undefined);
});

test('dispatcher pins a retained session and commits one turn after media succeeds', async () => {
  const events = [];
  const session = { session_id: A, account_id: 'pinned' };
  const D = dispatcher({
    './generationSessions': { lock: async () => session, bind: async (_, id) => events.push(['bind', id]), finish: async (_, success) => events.push(['finish', success]) },
    '../models': { Job: { updateOne: async () => ({ matchedCount: 1 }), findOneAndUpdate: () => ({ lean: async () => ({ _id: 'job', status: 'succeeded', type: 'image' }) }) } },
    './pool': { pool: { acquire: async (_, options) => {
      assert.equal(options.preferredAccountId, 'pinned');
      return { accountId: 'pinned', released: false, release() { this.released = true; }, client: { generateImage: async (_, options) => {
        assert.equal(options.sessionId, A); assert.equal(options.retainSession, true);
        return { success: true, sessionId: A, buffer: Buffer.from('image') };
      } } };
    } } },
    './storage': { saveFile: async () => ({ _id: 'file' }) }
  });
  const d = new D();d._loadReferences = async () => ({});d._finalize = () => {};
  await d._run({ _id: 'job', generation_session_id: 'gs_test', api_key_id: 'owner', execution_id: 'run', type: 'image', attempts: 1, max_attempts: 1 });
  assert.deepEqual(events, [['bind', 'pinned'], ['finish', true]]);
});

test('a failed retained turn is marked uncertain without account failover or paid retry', async () => {
  const finished = [];
  const D = dispatcher({
    './generationSessions': { lock: async () => ({ session_id: A, account_id: 'pinned' }), bind: async () => {}, finish: async (_, ok) => finished.push(ok) },
    '../models': { Job: { updateOne: async () => ({ matchedCount: 1 }), findOneAndUpdate: () => ({ lean: async () => ({ _id: 'job', status: 'failed' }) }) } },
    './pool': { pool: { hasAlternative: () => assert.fail('Retained turn must not fail over'), acquire: async () => ({ accountId: 'pinned', released: false, release() { this.released = true; }, client: { generateImage: async () => { throw new ApiError(ErrorCodes.UPSTREAM_ERROR); } } }) } }
  });
  const d = new D();d._loadReferences = async () => ({});d._finalize = () => {};
  await d._run({ _id: 'job', generation_session_id: 'gs_test', api_key_id: 'owner', execution_id: 'run', type: 'image', attempts: 1, max_attempts: 2 });
  assert.deepEqual(finished, [false]);
});

test('another turn in a busy generation session waits without acquiring an upstream slot', async () => {
  let update;
  const D = dispatcher({
    './generationSessions': { lock: async () => { throw new ApiError(ErrorCodes.CONVERSATION_BUSY); } },
    '../models': { Job: { updateOne: async (_, value) => { update = value; return { matchedCount: 1 }; } } },
    './pool': { pool: { acquire: () => assert.fail('Busy session must wait before upstream work') } }
  });
  const d = new D();
  await d._run({ _id: 'job', generation_session_id: 'gs_test', execution_id: 'run', type: 'video', attempts: 1, max_attempts: 1 });
  assert.equal(update.$set.status, 'queued');
  assert.equal(update.$inc.attempts, -1);
  assert.ok(update.$set.session_wait_until > new Date());
});

test('retained media turns ignore replayed video presentations and history from the preceding user turn', async () => {
  const c = client({ setTimeout: (fn, ms) => setTimeout(fn, [300, 1500, 2500, 3500].includes(ms) ? 2 : ms), setInterval: (fn, ms) => setInterval(fn, ms === 400 ? 5 : ms) });
  const old = { kind: 'video', id: 'old-video', session_id: A, data: { videos: [{ path: 'old.mp4' }] } };
  const fresh = { kind: 'video', id: 'new-video', session_id: A, data: { videos: [{ path: 'new.mp4' }] } };
  let newTurnVisible = false;
  c.sendRequest = async method => ({ status: 200, body: method === 'GET' ? JSON.stringify({ result: { chat_events: [
    { role: 'user', display_text: 'previous request' }, { event_name: 'delta.presentation', payload: old },
    ...(newTurnVisible ? [{ role: 'user', display_text: 'current request' }, { event_name: 'delta.presentation', payload: fresh }] : [])
  ] } }) : '{}' });
  let resolved = false;
  const pending = c.chat('current request', { sessionId: A, waitForKind: 'video', timeout: 1000 }).then(result => { resolved = true; return result; });
  await delay(5);
  c.emit('presentation', old, 1);
  c.emit('message_done', { session_id: A, presentations: [old] }, 2);
  c.emit('agent_status', { session_id: A, activity_code: 'idle' }, 3);
  await delay(25);
  assert.equal(resolved, false);
  newTurnVisible = true;
  const result = await pending;
  assert.equal(result.presentations.some(p => p.data?.videos?.[0]?.path === 'old.mp4'), false);
  assert.equal(result.presentations.some(p => p.data?.videos?.[0]?.path === 'new.mp4'), true);
});

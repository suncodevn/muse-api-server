'use strict';
const { GenerationSession } = require('../models/GenerationSession');
const { ApiError, ErrorCodes } = require('../errors');

function serialize(doc) {
  return { id: doc._id, object: 'generation_session', title: doc.title, state: doc.state,
    busy: Boolean(doc.active_execution), active_job_id: doc.active_job_id || null,
    turn_count: doc.turn_count, created_at: doc.created_at, updated_at: doc.updated_at };
}
async function get(id, apiKeyId) {
  const doc = await GenerationSession.findOne({ _id: id, api_key_id: apiKeyId }).lean();
  if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { param: 'generation_session_id' });
  if (doc.state !== 'ready') throw new ApiError(ErrorCodes.CONVERSATION_UNAVAILABLE, { message: 'This generation session has an uncertain upstream turn. Inspect the existing job before starting a new session.', param: 'generation_session_id' });
  return doc;
}
async function lock(job) {
  const doc = await GenerationSession.findOneAndUpdate({ _id: job.generation_session_id, api_key_id: job.api_key_id, state: 'ready', active_execution: null },
    { $set: { active_execution: job.execution_id, active_job_id: job._id, upstream_started: false } }, { returnDocument: 'after' }).lean();
  if (doc) return doc;
  await get(job.generation_session_id, job.api_key_id);
  throw new ApiError(ErrorCodes.CONVERSATION_BUSY);
}
async function bind(job, accountId) {
  const result = await GenerationSession.updateOne({ _id: job.generation_session_id, active_execution: job.execution_id,
    $or: [{ account_id: null }, { account_id: accountId }] }, { $set: { account_id: accountId, upstream_started: true } });
  if (!result.matchedCount) throw new ApiError(ErrorCodes.CONVERSATION_UNAVAILABLE);
}
async function finish(job, succeeded) {
  const filter = { _id: job.generation_session_id, active_execution: job.execution_id };
  if (!succeeded) {
    await GenerationSession.updateOne({ ...filter, upstream_started: true }, { $set: { state: 'uncertain' } });
  }
  await GenerationSession.updateOne(filter, { $set: { active_execution: null, active_job_id: null, upstream_started: false },
    ...(succeeded ? { $inc: { turn_count: 1 } } : {}) });
}
module.exports = { get, lock, bind, finish, serialize };

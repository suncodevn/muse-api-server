'use strict';
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { generateId } = require('../utils/crypto');
const schema = new mongoose.Schema({
  _id: { type: String, default: () => generateId('gs') },
  api_key_id: { type: String, required: true, index: true },
  title: { type: String, default: '', maxlength: 200 },
  session_id: { type: String, default: randomUUID, required: true },
  account_id: { type: String, default: null },
  state: { type: String, enum: ['ready', 'uncertain'], default: 'ready' },
  active_execution: { type: String, default: null },
  active_job_id: { type: String, default: null },
  upstream_started: { type: Boolean, default: false },
  turn_count: { type: Number, default: 0 }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, versionKey: false });
module.exports = { GenerationSession: mongoose.models.GenerationSession || mongoose.model('GenerationSession', schema) };

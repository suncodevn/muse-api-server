'use strict';
const express = require('express');
const { GenerationSession } = require('../models/GenerationSession');
const sessions = require('../services/generationSessions');
const { requireScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { z } = require('./helpers');
const { ApiError, ErrorCodes } = require('../errors');
const router = express.Router();
router.use(requireScope('images', 'videos'));
router.post('/', validate(z.object({ title: z.string().trim().max(200).default('') }).strict()), async (req, res) => {
  const doc = await GenerationSession.create({ api_key_id: req.auth.apiKey._id, title: req.valid.body.title });
  res.status(201).json(sessions.serialize(doc));
});
router.get('/:id', async (req, res) => {
  const doc = await GenerationSession.findOne({ _id: req.params.id, api_key_id: req.auth.apiKey._id }).lean();
  if (!doc) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND);
  res.json(sessions.serialize(doc));
});
module.exports = router;

'use strict';

/**
 * /v1 API surface.
 */

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { keyRateLimit } = require('../middleware/rateLimit');
const filesRouter = require('./files');
const imagesRouter = require('./images');
const videosRouter = require('./videos');
const jobsRouter = require('./jobs');
const usageRouter = require('./usage');
const adminRouter = require('./admin');
const { chatRouter, conversationsRouter } = require('./chat');

const v1 = express.Router();

// Files handle their own auth (signed download URLs work without an API key).
v1.use('/files', filesRouter);

// Every other endpoint requires an API key and is rate limited per key.
v1.use(authenticate, keyRateLimit);
v1.use('/generation-sessions', require('./generationSessions'));
v1.use('/images', imagesRouter);
v1.use('/videos', videosRouter);
v1.use('/jobs', jobsRouter);
v1.use('/chat', chatRouter);
v1.use('/conversations', conversationsRouter);
v1.use('/usage', usageRouter);
v1.use('/admin', adminRouter);

module.exports = v1;

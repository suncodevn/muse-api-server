'use strict';

/**
 * Image generation.
 *
 *   POST /v1/images/generations
 *
 * Synchronous by default (OpenAI-style response). Pass "async": true to get
 * a job object immediately (202) and poll GET /v1/jobs/:id or receive a
 * webhook.
 */

const express = require('express');
const storage = require('../services/storage');
const { requireScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { methodNotAllowed } = require('../middleware/errorHandler');
const { z, metadataSchema, referenceSchema } = require('./helpers');
const { submitGeneration } = require('./generation');

const router = express.Router();

const IMAGE_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];

const imageRequestSchema = z.object({
  generation_session_id: z.string().regex(/^gs_[A-Za-z0-9_-]+$/).optional(),
  prompt: z.string().trim().min(1).max(4000),
  model: z.string().max(64).optional(),
  n: z.literal(1).optional().describe('Only one image per request is supported.'),
  aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
  reference_image: referenceSchema.optional(),
  response_format: z.enum(['url', 'b64_json']).default('url'),
  async: z.boolean().default(false),
  webhook_url: z.string().max(2048).optional(),
  metadata: metadataSchema.optional()
}).strict();

router
  .route('/generations')
  .post(requireScope('images'), validate(imageRequestSchema), async (req, res) => {
    const body = req.valid.body;
    await submitGeneration(req, res, {
      type: 'image',
      sync: !body.async,
      params: { aspect_ratio: body.aspect_ratio || null, response_format: body.response_format },
      references: { image: body.reference_image },
      onSucceeded: async (job, response) => {
        const item = {
          file_id: job.output.file_id,
          mime_type: job.output.mime_type,
          bytes: job.output.bytes,
          revised_prompt: null
        };
        if (job.params?.response_format === 'b64_json') {
          const file = await storage.getFileOrThrow(job.output.file_id);
          item.b64_json = (await storage.readFileBuffer(file)).toString('base64');
        } else {
          const signed = storage.createSignedUrl(job.output.file_id);
          item.url = signed.url;
          item.url_expires_at = signed.expires_at;
        }
        response.status(200).json({
          created: Math.floor(new Date(job.completed_at || Date.now()).getTime() / 1000),
          job_id: job._id,
          data: [item]
        });
      }
    });
  })
  .all(methodNotAllowed(['POST']));

module.exports = router;
module.exports.IMAGE_ASPECT_RATIOS = IMAGE_ASPECT_RATIOS;

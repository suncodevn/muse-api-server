'use strict';

/**
 * Video generation.
 *
 *   POST /v1/videos/generations
 *
 * Asynchronous by default (202 + job object) because rendering typically
 * takes minutes. Pass "async": false to wait up to SYNC_WAIT_MAX_MS.
 */

const express = require('express');
const { requireScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { methodNotAllowed } = require('../middleware/errorHandler');
const { serializeJob } = require('../serializers');
const { z, metadataSchema, referenceSchema } = require('./helpers');
const { submitGeneration } = require('./generation');

const router = express.Router();

const VIDEO_ASPECT_RATIOS = ['16:9', '9:16', '1:1'];

const videoRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    model: z.string().max(64).optional(),
    aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).default('16:9'),
    duration: z.number().int().min(3).max(10).default(5),
    reference_image: referenceSchema.optional(),
    reference_images: z.array(z.object({
      image: referenceSchema,
      label: z.string().trim().max(120).default(''),
      role: z.string().trim().max(240).default('')
    }).strict()).min(1).max(100).optional(),
    reference_video: referenceSchema.optional(),
    async: z.boolean().default(true),
    webhook_url: z.string().max(2048).optional(),
    metadata: metadataSchema.optional()
  })
  .strict()
  .refine((b) => [b.reference_image, b.reference_images, b.reference_video].filter(Boolean).length <= 1, {
    message: 'Provide only one of reference_image, reference_images or reference_video',
    path: ['reference_video']
  });

router
  .route('/generations')
  .post(requireScope('videos'), validate(videoRequestSchema), async (req, res) => {
    const body = req.valid.body;
    await submitGeneration(req, res, {
      type: 'video',
      sync: body.async === false,
      params: { aspect_ratio: body.aspect_ratio, duration: body.duration },
      references: { image: body.reference_image, images: body.reference_images, video: body.reference_video },
      onSucceeded: (job, response) => response.status(200).json(serializeJob(job))
    });
  })
  .all(methodNotAllowed(['POST']));

module.exports = router;
module.exports.VIDEO_ASPECT_RATIOS = VIDEO_ASPECT_RATIOS;

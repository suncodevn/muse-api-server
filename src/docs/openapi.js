'use strict';

/**
 * OpenAPI 3.1 specification, served at GET /openapi.json and rendered by
 * Swagger UI at GET /docs.
 */

const config = require('../config');
const pkg = require('../../package.json');
const { ErrorCodes } = require('../errors/codes');
const { SCOPES } = require('../models/ApiKey');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name) => ({ $ref: `#/components/responses/${name}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example ? { example } : {}) } });

function errorTable() {
  const rows = Object.values(ErrorCodes).map((e) => `| ${e.status} | \`${e.type}\` | \`${e.code}\` | ${e.message} |`);
  return ['| HTTP | type | code | Default message |', '|---|---|---|---|', ...rows].join('\n');
}

const DESCRIPTION = `
REST API for AI **chat**, **image generation** and **video generation**, with
reference media (image-to-image, image-to-video, video-to-video) and a managed
pool of upstream provider accounts.

## Authentication
Send your API key in the \`Authorization\` header:

\`\`\`
Authorization: Bearer mk_live_...
\`\`\`

Keys carry scopes: ${SCOPES.map((s) => `\`${s}\``).join(', ')}. Administrative
endpoints (\`/v1/admin/*\`) require the master \`ADMIN_API_KEY\` or a key with
the \`admin\` scope.

## Conventions
* JSON request and response bodies, UTF-8.
* Resource IDs are prefixed strings (\`job_\`, \`file_\`, \`conv_\`, \`acct_\`, \`key_\`).
* Timestamps are ISO-8601 UTC (\`created_at\`). OpenAI-compatible payloads also
  carry a Unix \`created\` field.
* Lists use cursor pagination: \`?limit=20&cursor=<next_cursor>\`.
* Every response includes an \`X-Request-Id\` header; include it when contacting support.

## Reference media
Wherever a reference is accepted (\`reference_image\`, \`reference_video\`,
\`image_url.url\`, \`video_url.url\`) you may pass:
1. a file ID from \`POST /v1/files\` (recommended for large media),
2. a public \`https://\` URL, or
3. a base64 data URI (\`data:image/png;base64,...\`).

Limits: images up to ${Math.round(config.storage.maxImageBytes / 1048576)} MB (JPEG, PNG, WEBP, GIF),
videos up to ${Math.round(config.storage.maxVideoBytes / 1048576)} MB (MP4, MOV, WEBM).

## Synchronous vs asynchronous generation
* **Images** are synchronous by default. If generation exceeds the server wait
  window the API answers \`202 Accepted\` with a job object instead; poll the
  \`Location\` header.
* **Videos** are asynchronous by default (\`202 Accepted\` + job object).
* Poll \`GET /v1/jobs/{id}\` (honor \`Retry-After\`) or supply a \`webhook_url\`.

## Idempotency
\`POST\` generation endpoints accept an \`Idempotency-Key\` header (1-255
printable ASCII chars). Retrying with the same key and body returns the
original job (header \`Idempotent-Replayed: true\`); reusing a key with a
different body returns \`409 idempotency_conflict\`.

## Webhooks
When a job finishes, an event is POSTed to \`webhook_url\`:

\`\`\`json
{ "id": "evt_...", "object": "event", "type": "job.succeeded", "created": 1767225600, "data": { "id": "job_...", "object": "job", "...": "..." } }
\`\`\`

Verify the \`X-Webhook-Signature\` header (\`v1=<hex>\`) by computing
\`HMAC_SHA256(webhook_secret, X-Webhook-Timestamp + "." + raw_body)\` and
rejecting timestamps older than 5 minutes. Respond with any 2xx status;
other responses are retried with exponential backoff.

## Rate limits
Requests are limited per API key per minute (and per client IP). Responses
carry IETF \`RateLimit\` / \`RateLimit-Policy\` headers; when exceeded the API
returns \`429\` with \`Retry-After\`. Each key also has a maximum number of
concurrently queued/running jobs (\`429 concurrency_limit_exceeded\`).

## Errors
All errors share one envelope:

\`\`\`json
{
  "error": {
    "type": "invalid_request_error",
    "code": "validation_failed",
    "message": "prompt: Required.",
    "param": "prompt",
    "details": [{ "param": "prompt", "issue": "invalid_type", "message": "Required." }],
    "request_id": "req_..."
  }
}
\`\`\`

${errorTable()}
`;

function buildOpenApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Muse AI Gateway API',
      version: pkg.version,
      description: DESCRIPTION.trim()
    },
    servers: [{ url: config.server.publicBaseUrl }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Chat', description: 'OpenAI-compatible chat completions with image/video attachments.' },
      { name: 'Conversations', description: 'Stored multi-turn conversations.' },
      { name: 'Images', description: 'Text-to-image and image-to-image generation.' },
      { name: 'Videos', description: 'Text-to-video, image-to-video and video-to-video generation.' },
      { name: 'Jobs', description: 'Asynchronous generation jobs.' },
      { name: 'Files', description: 'Reference uploads and generated outputs.' },
      { name: 'Usage', description: 'Usage counters and limits for the calling key.' },
      { name: 'Admin: Accounts', description: 'Upstream provider accounts (session cookie / wss:// URL).' },
      { name: 'Admin: API Keys', description: 'Client API key management.' },
      { name: 'Admin: Operations', description: 'Runtime statistics.' },
      { name: 'Health', description: 'Liveness and readiness probes.' }
    ],
    paths: {
      '/v1/generation-sessions': {
        post: { tags: ['Generation sessions'], summary: 'Create a retained image/video project session (images or videos scope; no upstream generation)',
          requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 } } }) },
          responses: { 201: { description: 'Session created', content: json(ref('GenerationSession')) }, 401: resp('Error') } }
      },
      '/v1/generation-sessions/{id}': {
        get: { tags: ['Generation sessions'], summary: 'Inspect an owned generation session',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Session state (upstream account/session identifiers are private)', content: json(ref('GenerationSession')) }, 404: resp('Error') } }
      },
      // ------------------------------------------------------------------ Chat
      '/v1/chat/completions': {
        post: {
          tags: ['Chat'],
          operationId: 'createChatCompletion',
          summary: 'Create a chat completion',
          description: 'OpenAI-compatible. Set `stream: true` for Server-Sent Events (`chat.completion.chunk` objects, terminated by `data: [DONE]`; errors after the stream starts arrive as `event: error`). Pass `conversation_id` from a previous response to continue a conversation; only the final user message is sent in that case. Up to 4 images and 1 video can be attached to the final user message.',
          requestBody: { required: true, content: json(ref('ChatCompletionRequest'), {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this picture.' }, { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } }] }]
          }) },
          responses: {
            200: { description: 'Completion (JSON) or event stream when `stream` is true.', content: { ...json(ref('ChatCompletion')), 'text/event-stream': { schema: { type: 'string' } } } },
            400: resp('BadRequest'), 401: resp('Unauthorized'), 403: resp('Forbidden'), 404: resp('NotFound'), 409: resp('Conflict'),
            422: resp('Unprocessable'), 429: resp('TooManyRequests'), 502: resp('UpstreamError'), 503: resp('ServiceUnavailable'), 504: resp('UpstreamTimeout')
          }
        }
      },
      '/v1/conversations': {
        get: {
          tags: ['Conversations'], operationId: 'listConversations', summary: 'List conversations',
          parameters: [{ $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }],
          responses: { 200: { description: 'A page of conversations.', content: json(listOf('Conversation')) }, 401: resp('Unauthorized') }
        }
      },
      '/v1/conversations/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: { tags: ['Conversations'], operationId: 'getConversation', summary: 'Retrieve a conversation', responses: { 200: { description: 'Conversation.', content: json(ref('Conversation')) }, 404: resp('NotFound') } },
        delete: { tags: ['Conversations'], operationId: 'deleteConversation', summary: 'Delete a conversation', responses: { 200: { description: 'Deleted.', content: json(ref('Deleted')) }, 404: resp('NotFound') } }
      },

      // ---------------------------------------------------------------- Images
      '/v1/images/generations': {
        post: {
          tags: ['Images'], operationId: 'createImage', summary: 'Generate an image',
          description: 'Synchronous by default. Returns `202` with a job object when `async` is true or when generation outlasts the server wait window.',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json(ref('ImageGenerationRequest'), { prompt: 'A watercolor fox in a misty forest', aspect_ratio: '16:9' }) },
          responses: {
            200: { description: 'Image generated.', content: json(ref('ImageGenerationResponse')) },
            202: { description: 'Accepted; poll the job in the Location header.', headers: { Location: { schema: { type: 'string' } } }, content: json(ref('Job')) },
            400: resp('BadRequest'), 401: resp('Unauthorized'), 403: resp('Forbidden'), 409: resp('Conflict'), 413: resp('PayloadTooLarge'), 415: resp('UnsupportedMediaType'),
            422: resp('Unprocessable'), 429: resp('TooManyRequests'), 502: resp('UpstreamError'), 503: resp('ServiceUnavailable'), 504: resp('UpstreamTimeout')
          }
        }
      },

      // ---------------------------------------------------------------- Videos
      '/v1/videos/generations': {
        post: {
          tags: ['Videos'], operationId: 'createVideo', summary: 'Generate a video',
          description: 'Asynchronous by default: returns `202` with a job object. Set `async: false` to wait (up to the server wait window).',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: { required: true, content: json(ref('VideoGenerationRequest'), { prompt: 'Waves crashing on a beach at sunset, cinematic', aspect_ratio: '16:9', duration: 5 }) },
          responses: {
            200: { description: 'Video generated (only when `async` is false).', content: json(ref('Job')) },
            202: { description: 'Accepted.', headers: { Location: { schema: { type: 'string' } } }, content: json(ref('Job')) },
            400: resp('BadRequest'), 401: resp('Unauthorized'), 403: resp('Forbidden'), 409: resp('Conflict'), 413: resp('PayloadTooLarge'), 415: resp('UnsupportedMediaType'),
            422: resp('Unprocessable'), 429: resp('TooManyRequests'), 503: resp('ServiceUnavailable')
          }
        }
      },

      // ------------------------------------------------------------------ Jobs
      '/v1/jobs': {
        get: {
          tags: ['Jobs'], operationId: 'listJobs', summary: 'List jobs',
          parameters: [
            { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] } },
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['image', 'video'] } }
          ],
          responses: { 200: { description: 'A page of jobs.', content: json(listOf('Job')) }, 401: resp('Unauthorized') }
        }
      },
      '/v1/jobs/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: { tags: ['Jobs'], operationId: 'getJob', summary: 'Retrieve a job', responses: { 200: { description: 'Job.', content: json(ref('Job')) }, 404: resp('NotFound') } }
      },
      '/v1/jobs/{id}/cancel': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        post: { tags: ['Jobs'], operationId: 'cancelJob', summary: 'Cancel a job', responses: { 200: { description: 'Canceled job.', content: json(ref('Job')) }, 404: resp('NotFound'), 409: resp('Conflict') } }
      },
      '/v1/jobs/{id}/content': {
        parameters: [{ $ref: '#/components/parameters/Id' }, { name: 'download', in: 'query', schema: { type: 'boolean' }, description: 'Send as attachment.' }],
        get: { tags: ['Jobs'], operationId: 'getJobContent', summary: 'Download job output', responses: { 200: { description: 'Media bytes (supports HTTP Range).', content: { 'image/*': {}, 'video/*': {} } }, 404: resp('NotFound'), 409: resp('Conflict') } }
      },

      // ----------------------------------------------------------------- Files
      '/v1/files': {
        post: {
          tags: ['Files'], operationId: 'uploadFile', summary: 'Upload reference media',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } },
              'application/json': { schema: ref('FileUploadJson') }
            }
          },
          responses: { 201: { description: 'File stored.', content: json(ref('File')) }, 400: resp('BadRequest'), 413: resp('PayloadTooLarge'), 415: resp('UnsupportedMediaType') }
        },
        get: {
          tags: ['Files'], operationId: 'listFiles', summary: 'List files',
          parameters: [
            { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' },
            { name: 'purpose', in: 'query', schema: { type: 'string', enum: ['reference', 'output'] } },
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['image', 'video'] } }
          ],
          responses: { 200: { description: 'A page of files.', content: json(listOf('File')) } }
        }
      },
      '/v1/files/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: { tags: ['Files'], operationId: 'getFile', summary: 'Retrieve file metadata', responses: { 200: { description: 'File.', content: json(ref('File')) }, 404: resp('NotFound') } },
        delete: { tags: ['Files'], operationId: 'deleteFile', summary: 'Delete a file', responses: { 200: { description: 'Deleted.', content: json(ref('Deleted')) }, 404: resp('NotFound') } }
      },
      '/v1/files/{id}/content': {
        parameters: [
          { $ref: '#/components/parameters/Id' },
          { name: 'expires', in: 'query', schema: { type: 'integer' }, description: 'Signed URL expiry (Unix seconds).' },
          { name: 'signature', in: 'query', schema: { type: 'string' }, description: 'Signed URL signature. When present, no API key is required.' },
          { name: 'download', in: 'query', schema: { type: 'boolean' } }
        ],
        get: { tags: ['Files'], operationId: 'getFileContent', summary: 'Download file content', security: [{ bearerAuth: [] }, {}], responses: { 200: { description: 'Media bytes (supports HTTP Range).' }, 403: resp('Forbidden'), 404: resp('NotFound') } }
      },

      // ----------------------------------------------------------------- Usage
      '/v1/usage': {
        get: { tags: ['Usage'], operationId: 'getUsage', summary: 'Usage and limits for the calling key', responses: { 200: { description: 'Usage.', content: json(ref('Usage')) }, 401: resp('Unauthorized') } }
      },

      // ------------------------------------------------------- Admin: Accounts
      '/v1/admin/accounts': {
        get: {
          tags: ['Admin: Accounts'], operationId: 'listAccounts', summary: 'List upstream accounts',
          parameters: [
            { $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' },
            { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'group', in: 'query', schema: { type: 'string' } },
            { name: 'enabled', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }
          ],
          responses: { 200: { description: 'A page of accounts.', content: json(listOf('Account')) }, 403: resp('Forbidden') }
        },
        post: {
          tags: ['Admin: Accounts'], operationId: 'createAccount', summary: 'Add an upstream account',
          description: 'Provide a session cookie (must contain `hatch_sess=`), a `wss://` URL, or both. A cookie alone is automatically exchanged for a wss:// URL and enables automatic renewal; a wss:// URL alone expires after ~20 hours. With `validate: true` (default) the account is connected and tested before being saved.',
          requestBody: { required: true, content: json(ref('AccountCreateRequest'), { name: 'Account 01', cookie: 'datr=...; hatch_sess=...', capabilities: { chat: true, image: true, video: true } }) },
          responses: { 201: { description: 'Account created.', content: json(ref('Account')) }, 400: resp('BadRequest'), 403: resp('Forbidden'), 422: resp('Unprocessable') }
        }
      },
      '/v1/admin/accounts/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: { tags: ['Admin: Accounts'], operationId: 'getAccount', summary: 'Retrieve an account', responses: { 200: { description: 'Account.', content: json(ref('Account')) }, 404: resp('NotFound') } },
        patch: {
          tags: ['Admin: Accounts'], operationId: 'updateAccount', summary: 'Update an account',
          description: 'Omitted credential fields keep the stored value (e.g. send only `wss_url` to replace the URL but keep the cookie). Invalid new credentials are rolled back when `validate` is true.',
          requestBody: { required: true, content: json(ref('AccountUpdateRequest')) },
          responses: { 200: { description: 'Account.', content: json(ref('Account')) }, 404: resp('NotFound'), 422: resp('Unprocessable') }
        },
        delete: { tags: ['Admin: Accounts'], operationId: 'deleteAccount', summary: 'Delete an account', responses: { 200: { description: 'Deleted.', content: json(ref('Deleted')) }, 404: resp('NotFound') } }
      },
      '/v1/admin/accounts/{id}/test': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        post: { tags: ['Admin: Accounts'], operationId: 'testAccount', summary: 'Test connectivity', responses: { 200: { description: 'Test result (`ok` false on upstream failure).', content: json(ref('AccountTest')) }, 404: resp('NotFound'), 409: resp('Conflict') } }
      },
      '/v1/admin/accounts/{id}/refresh': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        post: { tags: ['Admin: Accounts'], operationId: 'refreshAccount', summary: 'Regenerate the wss:// URL from the cookie', responses: { 200: { description: 'Account.', content: json(ref('Account')) }, 404: resp('NotFound'), 422: resp('Unprocessable') } }
      },
      '/v1/admin/accounts/{id}/sessions/cleanup': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        post: {
          tags: ['Admin: Accounts'], operationId: 'cleanupAccountSessions', summary: 'Delete secondary upstream threads',
          requestBody: { content: json({ type: 'object', properties: { force: { type: 'boolean', default: false } } }) },
          responses: { 200: { description: 'Cleanup result.', content: json({ type: 'object', properties: { object: { const: 'session_cleanup' }, account_id: { type: 'string' }, deleted: { type: 'integer' } } }) }, 409: resp('Conflict') }
        }
      },

      // ------------------------------------------------------- Admin: API keys
      '/v1/admin/api-keys': {
        get: { tags: ['Admin: API Keys'], operationId: 'listApiKeys', summary: 'List API keys', parameters: [{ $ref: '#/components/parameters/Limit' }, { $ref: '#/components/parameters/Cursor' }], responses: { 200: { description: 'A page of keys.', content: json(listOf('ApiKey')) } } },
        post: {
          tags: ['Admin: API Keys'], operationId: 'createApiKey', summary: 'Create an API key',
          description: 'The plaintext `key` and `webhook_secret` are returned only once. Store them securely.',
          requestBody: { required: true, content: json(ref('ApiKeyCreateRequest'), { name: 'Production - Acme Inc.', scopes: ['chat', 'images', 'videos', 'files'], rate_limit_per_minute: 300 }) },
          responses: { 201: { description: 'Key created.', content: json(ref('ApiKeyWithSecret')) }, 400: resp('BadRequest') }
        }
      },
      '/v1/admin/api-keys/{id}': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        get: { tags: ['Admin: API Keys'], operationId: 'getApiKey', summary: 'Retrieve an API key', responses: { 200: { description: 'Key.', content: json(ref('ApiKey')) }, 404: resp('NotFound') } },
        patch: { tags: ['Admin: API Keys'], operationId: 'updateApiKey', summary: 'Update an API key', requestBody: { required: true, content: json(ref('ApiKeyUpdateRequest')) }, responses: { 200: { description: 'Key.', content: json(ref('ApiKey')) }, 404: resp('NotFound') } },
        delete: { tags: ['Admin: API Keys'], operationId: 'deleteApiKey', summary: 'Delete (revoke) an API key', responses: { 200: { description: 'Deleted.', content: json(ref('Deleted')) }, 404: resp('NotFound') } }
      },
      '/v1/admin/api-keys/{id}/webhook-secret/rotate': {
        parameters: [{ $ref: '#/components/parameters/Id' }],
        post: { tags: ['Admin: API Keys'], operationId: 'rotateWebhookSecret', summary: 'Rotate the webhook signing secret', responses: { 200: { description: 'New secret.', content: json({ type: 'object', properties: { id: { type: 'string' }, object: { const: 'api_key' }, webhook_secret: { type: 'string' } } }) } } }
      },
      '/v1/admin/stats': {
        get: { tags: ['Admin: Operations'], operationId: 'getStats', summary: 'Runtime statistics', responses: { 200: { description: 'Stats.', content: json({ type: 'object' }) } } }
      },

      // ---------------------------------------------------------------- Health
      '/health': { get: { tags: ['Health'], operationId: 'liveness', summary: 'Liveness probe', security: [], responses: { 200: { description: 'Process is alive.' } } } },
      '/health/ready': { get: { tags: ['Health'], operationId: 'readiness', summary: 'Readiness probe', security: [], responses: { 200: { description: 'Ready.' }, 503: { description: 'Not ready.' } } } }
    },

    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'API key', description: 'API key, e.g. `mk_live_...`' }
      },
      parameters: {
        Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        Cursor: { name: 'cursor', in: 'query', schema: { type: 'string' }, description: '`next_cursor` from the previous page.' },
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 255 }, description: 'Makes retries safe; see Idempotency.' }
      },
      responses: {
        BadRequest: errorResponse('Invalid request (`invalid_request_error`).'),
        Unauthorized: errorResponse('Missing or invalid API key (`authentication_error`).'),
        Forbidden: errorResponse('Insufficient scope or invalid signature (`permission_error`).'),
        NotFound: errorResponse('Resource not found (`not_found_error`).'),
        Conflict: errorResponse('State conflict (`conflict_error`).'),
        PayloadTooLarge: errorResponse('Payload too large.'),
        UnsupportedMediaType: errorResponse('Unsupported media type.'),
        Unprocessable: errorResponse('Request understood but could not be processed.'),
        TooManyRequests: errorResponse('Rate or concurrency limit exceeded. See `Retry-After`.'),
        UpstreamError: errorResponse('Upstream provider error (`upstream_error`).'),
        ServiceUnavailable: errorResponse('Temporarily unavailable. See `Retry-After`.'),
        UpstreamTimeout: errorResponse('Upstream provider timeout.')
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['type', 'code', 'message', 'request_id'],
              properties: {
                type: { type: 'string', enum: [...new Set(Object.values(ErrorCodes).map((e) => e.type))] },
                code: { type: 'string', enum: Object.values(ErrorCodes).map((e) => e.code) },
                message: { type: 'string' },
                param: { type: ['string', 'null'] },
                details: {},
                request_id: { type: 'string' }
              }
            }
          }
        },
        Metadata: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, maxProperties: 16, description: 'Up to 16 key/value pairs (keys <= 40 chars, string values <= 500 chars).' },
        Reference: { type: 'string', description: 'File ID (`file_...`), public https URL, or base64 data URI.' },
        Deleted: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string' }, deleted: { const: true } } },

        ChatMessage: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'array',
                  items: {
                    oneOf: [
                      { type: 'object', required: ['type', 'text'], properties: { type: { const: 'text' }, text: { type: 'string' } } },
                      { type: 'object', required: ['type', 'image_url'], properties: { type: { const: 'image_url' }, image_url: { type: 'object', required: ['url'], properties: { url: ref('Reference') } } } },
                      { type: 'object', required: ['type', 'video_url'], properties: { type: { const: 'video_url' }, video_url: { type: 'object', required: ['url'], properties: { url: ref('Reference') } } } }
                    ]
                  }
                }
              ]
            }
          }
        },
        ChatCompletionRequest: {
          type: 'object',
          required: ['messages'],
          properties: {
            model: { type: 'string', description: 'Optional; echoed back. Default `muse-1`.' },
            messages: { type: 'array', minItems: 1, maxItems: 100, items: ref('ChatMessage') },
            stream: { type: 'boolean', default: false },
            conversation_id: { type: 'string', description: 'Continue a stored conversation.' },
            store: { type: 'boolean', default: true, description: 'Persist the conversation so it can be continued. When false, the upstream thread is deleted after the response.' },
            metadata: ref('Metadata')
          },
          additionalProperties: true
        },
        ChatAttachment: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['image', 'video'] }, file_id: { type: 'string' }, url: { type: 'string' }, url_expires_at: { type: 'string', format: 'date-time' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }
        },
        ChatCompletion: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { const: 'chat.completion' },
            created: { type: 'integer' },
            model: { type: 'string' },
            conversation_id: { type: ['string', 'null'] },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: { type: 'object', properties: { role: { const: 'assistant' }, content: { type: 'string' }, attachments: { type: 'array', items: ref('ChatAttachment') } } },
                  finish_reason: { type: 'string' }
                }
              }
            },
            usage: { type: 'object', description: 'Approximate token counts.', properties: { prompt_tokens: { type: 'integer' }, completion_tokens: { type: 'integer' }, total_tokens: { type: 'integer' } } }
          }
        },
        Conversation: {
          type: 'object',
          properties: {
            id: { type: 'string' }, object: { const: 'conversation' }, title: { type: ['string', 'null'] }, message_count: { type: 'integer' },
            last_message_at: { type: ['string', 'null'], format: 'date-time' }, metadata: ref('Metadata'), created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }
          }
        },

        GenerationSession: {
          type: 'object', properties: { id: { type: 'string' }, object: { const: 'generation_session' }, title: { type: 'string' },
            state: { type: 'string', enum: ['ready', 'uncertain'] }, busy: { type: 'boolean' }, active_job_id: { type: ['string', 'null'] },
            turn_count: { type: 'integer' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } }
        },
        ImageGenerationRequest: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: {
            generation_session_id: { type: 'string', pattern: '^gs_[A-Za-z0-9_-]+$', description: 'Retain and continue one upstream session on its owning account. Turns execute exclusively. Interrupted turns mark the session uncertain and are not automatically retried.' },
            prompt: { type: 'string', minLength: 1, maxLength: 4000 },
            model: { type: 'string' },
            n: { type: 'integer', const: 1 },
            aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
            reference_image: ref('Reference'),
            response_format: { type: 'string', enum: ['url', 'b64_json'], default: 'url' },
            async: { type: 'boolean', default: false },
            webhook_url: { type: 'string', format: 'uri' },
            metadata: ref('Metadata')
          }
        },
        ImageGenerationResponse: {
          type: 'object',
          properties: {
            created: { type: 'integer' },
            job_id: { type: 'string' },
            data: {
              type: 'array',
              items: { type: 'object', properties: { url: { type: 'string' }, url_expires_at: { type: 'string', format: 'date-time' }, b64_json: { type: 'string' }, file_id: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' }, revised_prompt: { type: ['string', 'null'] } } }
            }
          }
        },
        VideoGenerationRequest: {
          type: 'object',
          required: ['prompt'],
          additionalProperties: false,
          properties: {
            generation_session_id: { type: 'string', pattern: '^gs_[A-Za-z0-9_-]+$', description: 'Retain and continue one upstream session on its owning account. Turns execute exclusively. Interrupted turns mark the session uncertain and are not automatically retried.' },
            prompt: { type: 'string', minLength: 1, maxLength: 4000 },
            model: { type: 'string' },
            aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
            duration: { type: 'integer', minimum: 3, maximum: 10, default: 5, description: 'Seconds.' },
            reference_image: ref('Reference'),
            reference_video: ref('Reference'),
            async: { type: 'boolean', default: true },
            webhook_url: { type: 'string', format: 'uri' },
            metadata: ref('Metadata')
          }
        },
        Job: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { const: 'job' },
            generation_session_id: { type: ['string', 'null'] },
            type: { type: 'string', enum: ['image', 'video'] },
            status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] },
            progress: { type: 'integer', minimum: 0, maximum: 100, description: 'Estimated completion percentage.' },
            progress_text: { type: ['string', 'null'] },
            prompt: { type: 'string' },
            params: { type: 'object' },
            reference: { type: 'object' },
            output: {
              type: ['object', 'null'],
              properties: { file_id: { type: 'string' }, url: { type: 'string', description: 'Signed URL; no API key needed until it expires.' }, url_expires_at: { type: 'string', format: 'date-time' }, mime_type: { type: 'string' }, bytes: { type: 'integer' }, text: { type: ['string', 'null'] } }
            },
            error: { type: ['object', 'null'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
            attempts: { type: 'integer' },
            webhook: { type: ['object', 'null'] },
            metadata: ref('Metadata'),
            created_at: { type: 'string', format: 'date-time' },
            started_at: { type: ['string', 'null'], format: 'date-time' },
            completed_at: { type: ['string', 'null'], format: 'date-time' }
          }
        },
        File: {
          type: 'object',
          properties: {
            id: { type: 'string' }, object: { const: 'file' }, purpose: { type: 'string', enum: ['reference', 'output'] }, kind: { type: 'string', enum: ['image', 'video'] },
            mime_type: { type: 'string' }, bytes: { type: 'integer' }, filename: { type: ['string', 'null'] }, sha256: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' }, expires_at: { type: 'string', format: 'date-time' }
          }
        },
        FileUploadJson: {
          type: 'object',
          description: 'Provide exactly one of `data` or `url`.',
          properties: { data: { type: 'string', description: 'Base64 or data URI.' }, url: { type: 'string', format: 'uri' }, filename: { type: 'string' } }
        },
        Usage: {
          type: 'object',
          properties: {
            object: { const: 'usage' },
            api_key: { type: 'object' },
            limits: { type: 'object', properties: { rate_limit_per_minute: { type: 'integer' }, max_concurrent_jobs: { type: 'integer' } } },
            usage: { type: 'object', properties: { requests: { type: 'integer' }, chat_completions: { type: 'integer' }, images: { type: 'integer' }, videos: { type: 'integer' } } },
            active_jobs: { type: 'object', properties: { queued: { type: 'integer' }, running: { type: 'integer' } } }
          }
        },

        AccountCreateRequest: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 100 },
            cookie: { type: 'string', description: 'Session cookie header value containing `hatch_sess=`.' },
            wss_url: { type: 'string', description: 'WebSocket URL starting with `wss://`.' },
            credential: { type: 'string', description: 'Alternative: raw combined credential (cookie and/or wss:// URL).' },
            proxy: { type: ['string', 'null'], description: 'Optional outbound proxy (`http://user:pass@host:port`).' },
            group: { type: 'string', description: 'Shard key; only nodes with matching ACCOUNT_GROUP load the account.' },
            enabled: { type: 'boolean', default: true },
            capabilities: { type: 'object', properties: { chat: { type: 'boolean' }, image: { type: 'boolean' }, video: { type: 'boolean' } } },
            concurrency: { type: 'object', properties: { chat: { type: ['integer', 'null'] }, image: { type: ['integer', 'null'] }, video: { type: ['integer', 'null'] } } },
            metadata: ref('Metadata'),
            validate: { type: 'boolean', default: true, description: 'Connect and test before saving.' }
          }
        },
        AccountUpdateRequest: { allOf: [ref('AccountCreateRequest')], description: 'All fields optional.' },
        Account: {
          type: 'object',
          properties: {
            id: { type: 'string' }, object: { const: 'account' }, name: { type: 'string' }, enabled: { type: 'boolean' },
            status: { type: 'string', enum: ['unknown', 'connecting', 'online', 'degraded', 'offline', 'expired', 'disabled'] },
            group: { type: 'string' }, credential_type: { type: 'string', enum: ['cookie', 'wss', 'hybrid', 'init'] }, credential_preview: { type: 'string' },
            wss_expires_at: { type: ['string', 'null'], format: 'date-time' }, has_proxy: { type: 'boolean' },
            capabilities: { type: 'object' }, concurrency: { type: 'object' }, live: { type: ['object', 'null'] }, last_error: { type: ['object', 'null'] },
            last_connected_at: { type: ['string', 'null'], format: 'date-time' }, stats: { type: 'object' }, metadata: ref('Metadata'),
            created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }
          }
        },
        AccountTest: {
          type: 'object',
          properties: { object: { const: 'account_test' }, account_id: { type: 'string' }, ok: { type: 'boolean' }, status: { type: 'string' }, latency_ms: { type: 'integer' }, credential_type: { type: 'string' }, wss_expires_at: { type: ['string', 'null'] }, auto_renew: { type: 'boolean' }, error: { type: 'object' } }
        },
        ApiKeyCreateRequest: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 100 },
            scopes: { type: 'array', items: { type: 'string', enum: SCOPES }, default: ['chat', 'images', 'videos', 'files'] },
            expires_at: { type: ['string', 'null'], format: 'date-time' },
            rate_limit_per_minute: { type: ['integer', 'null'], minimum: 1 },
            max_concurrent_jobs: { type: ['integer', 'null'], minimum: 1 },
            metadata: ref('Metadata')
          }
        },
        ApiKeyUpdateRequest: { allOf: [ref('ApiKeyCreateRequest'), { type: 'object', properties: { enabled: { type: 'boolean' } } }], description: 'All fields optional.' },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string' }, object: { const: 'api_key' }, name: { type: 'string' }, key_prefix: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } },
            enabled: { type: 'boolean' }, expires_at: { type: ['string', 'null'], format: 'date-time' }, rate_limit_per_minute: { type: ['integer', 'null'] }, max_concurrent_jobs: { type: ['integer', 'null'] },
            usage: { type: 'object' }, last_used_at: { type: ['string', 'null'], format: 'date-time' }, metadata: ref('Metadata'),
            created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' }
          }
        },
        ApiKeyWithSecret: { allOf: [ref('ApiKey'), { type: 'object', properties: { key: { type: 'string', description: 'Shown only once.' }, webhook_secret: { type: 'string', description: 'Shown only once.' } } }] }
      }
    }
  };
}

function listOf(name) {
  return {
    type: 'object',
    properties: {
      object: { const: 'list' },
      url: { type: 'string' },
      data: { type: 'array', items: ref(name) },
      has_more: { type: 'boolean' },
      next_cursor: { type: ['string', 'null'] }
    }
  };
}

function errorResponse(description) {
  return { description, content: json(ref('Error')) };
}

module.exports = { buildOpenApiSpec };

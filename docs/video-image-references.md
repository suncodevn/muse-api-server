# Ordered video image references (proposal)

The video generation endpoint accepts an optional ordered list:

```json
{
  "prompt": "The character walks into the workshop.",
  "reference_images": [
    {"image":"file_CHARACTER","label":"character","role":"character design and materials"},
    {"image":"file_WORKSHOP","label":"workshop","role":"environment and lighting"}
  ],
  "duration": 5,
  "async": true
}
```

Each image uses the same reference formats and ownership checks as the existing single-image input (uploaded file ID, data URI, or an allowed remote URL). Image is required; label and role default to empty strings. Labels are limited to 120 characters and roles to 240.

Choose only one of reference_image, reference_images, or reference_video. Existing single-reference requests retain their behavior. The image endpoint is unchanged.

The list retains attachment order, including repeated images. Labels and roles are appended to the prompt as guidance; they are not dedicated model controls and do not lock a first or last frame.

The local list limit is 100 items, and total resolved image bytes must fit the existing MAX_IMAGE_MB limit (default 20 MiB). This is a resource cap, not a verified upstream capacity claim. HTTP JSON body limits also apply. Local usage previously included five references; output quality and upstream acceptance remain model-dependent.

Offline tests cover request validation, conflicting inputs, metadata limits, combined bytes, owned file loading, attachment order/repetition, and idempotency fingerprints/replay. Syntax and Studio checks also pass. No new upstream generation was submitted while preparing this contribution; distributed load was not validated.

This change is independent of the persistent-generation-session proposal and does not add its API field.

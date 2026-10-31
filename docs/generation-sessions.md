# Persistent generation sessions (proposal)

Create a session with an API key that has images or videos scope:

```http
POST /v1/generation-sessions
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"title":"Sequential shots"}
```

Save the returned `id` (for example, `gs_EXAMPLE`) and pass it to related image/video requests:

```json
{
  "prompt": "Create the next shot using the established character design.",
  "generation_session_id": "gs_EXAMPLE",
  "async": true
}
```

Use `GET /v1/generation-sessions/{id}` to inspect state, busy status, active job and completed turn count. The upstream thread and account identifiers are not exposed. Session ownership is scoped to the creating API key.

Turns in one session execute exclusively and remain pinned to the same account. A busy session requeues waiting jobs without consuming an attempt. Omit the optional field to retain the existing independent-job behavior.

Session turns do not automatically retry generation or switch accounts. A failure after binding the upstream account, or a detected orphaned turn, conservatively marks the session uncertain. Inspect the existing job and upstream outcome before explicitly starting another session; a timeout does not establish that generation stopped. The inspection endpoint remains available for uncertain sessions.

## Review limitations

This is an opt-in API proposal. Retention expiry, explicit close/delete, and a user-facing reconciliation operation for uncertain sessions are not implemented. Upstream thread lifetime and exact visual continuity are not guaranteed. Crash recovery uses the existing stale-heartbeat sweep; it is not an immediate unlock guarantee. Interrupted/aborted turn behavior and multi-node races deserve further integration review.

Offline architecture tests cover ownership, exclusive locking, account affinity, busy requeueing, uncertainty, retained outputs, and exclusion of previous-turn media. Syntax and Studio checks also pass. No new upstream generation was submitted while preparing this contribution. Real MongoDB crash recovery and distributed load were not rerun for this PR.

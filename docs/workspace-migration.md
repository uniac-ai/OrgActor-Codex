# Private inbox migration

The Provider keeps delivery policy in its existing `runtime.json`. Each Actor's `inbox` contains `scope`, `after` and `baseline`. `inboxScope(bootstrap)` derives the scope from the actual Hub URL/credential, Actor ID, native thread and incoming filter. A missing or mismatched scope, missing baseline, invalid row, duplicate message ID or foreign recipient holds inbox delivery. Historical legacy cursors remain readable and are never used as Workspace continuations.

The host's authoritative import baseline has this format:

```json
{
  "purpose": "Historical import baseline; not a processing or delivery receipt",
  "messages": [{ "messageID": "exact-imported-id", "recipientID": "recipient-id", "cursor": 1 }]
}
```

The parent coordinates a consistent Hub/Provider snapshot before installing this state. For each existing Actor, select its exact recipient rows into `inbox.baseline`, derive its current scope and set `after` to zero. An explicit empty baseline is appropriate only when that authoritative inventory contains no imported messages for the Actor. A rehearsal baseline establishes format and tests; it is never the actual host baseline. Do not infer coverage from unread state, legacy cursor values, receipt counts or the largest imported cursor. New provisioning initializes an explicit empty baseline for its newly created execution binding.

Traversal starts from zero, comparing every incoming message with exact baseline ID/recipient/cursor triples. Matching historical rows skip native dispatch; a mismatch stops traversal. Other messages use the existing `message:<ID>` receipt and content/sender checks. Each accepted receipt is saved before continuation movement. A crash partway through a page rechecks existing receipts; unknown native input never gets replayed. Historical baseline rows claim neither processing nor completion, and existing receipts, native mappings, provisioning records and paused intent remain unchanged.

Apply any migration only to a consistent owned copy before the separately authorized cutover. Preserve the complete private file and its unknown fields. The source tests use representative private data and synthetic endpoints; they do not prove current live native activity or current private-corpus readability. A full private-copy proof requires a parent-coordinated capture. A rollback also requires the matching Hub wire/storage version and cannot discard later journal entries.

# Native Form recovery

The current manager selected by the canonical `team` contract is the ordinary designated respondent. No manager leaves input pending. The Provider uses its attached Actor identity as requester, reads its private bound Form ID and validates the response and current native scope. Organization-wide read access, requester closure and a response from another Actor cannot authorize native input.

Form creation is attempted once after a durable private marker. A returned canonical Form ID persists to its original retained binding even after native scope ends, without changing its lifecycle state; superseded bindings are not updated. An unknown reply uses public requester-filtered Form reads and exact bound fields to recover a unique Form; absence or ambiguity creates no duplicate. One valid respondent response suffices. The private `answerAttempt` saves the selected typed response and Form revision before native delivery. The native socket's void send and subsequent request-resolution event provide no correlated answer confirmation, so the Provider never automatically resends an uncertain attempt or closes its Form. A future automatic closure requires supported evidence that this exact native request accepted this exact answer. No Work mutation is part of this flow.

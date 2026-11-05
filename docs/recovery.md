# Private delivery and recovery

## The delivered-through position

The Provider keeps delivery policy in its existing `runtime.json`. Each Actor's `delivered` is the Hub `attention` position this executor has delivered through; the Hub and the Workspace keep no delivery state. When an Actor first connects without one, its position starts at the Hub's current position, so what happened before is not its input. A position the Hub refuses as one it never issued, as after its home was replaced, restarts from now.

Each read returns the items after the position. Every item's input receipt, `kind:recordID:at`, is saved before the position moves. A crash partway through a read re-reads from the old position; existing receipts claim their items, and unknown native input is never replayed. A steer the native session refused keeps its failed receipt, and the item starts the next turn under `kind:recordID:at:next`.

A runtime from before `attention` keeps its private `inbox` and `cursor` fields unread. Its Actors start at the Hub's current position when they next connect, so Messages sent while the runtime was down are not delivered as input; they remain in each pair's conversation. Existing receipts, native mappings, provisioning records and paused intent are unchanged.

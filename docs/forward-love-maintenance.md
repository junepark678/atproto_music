# Deferred-love maintenance bounds

Deferred-love maintenance uses two rotated phases. The guaranteed phase gives
each of the five lanes up to 22 charged units in the current turn order. A
second pass shares the remaining part of the 110-unit budget in that same
rotation. A lane that reaches an empty frontier stops for the invocation.

The scheduler reserves these conservative per-step ceilings before executing
mutating SQL. In each lane transaction it measures `total_changes()` around
each step and aborts that transaction before commit if either measured writes
or declared inspection work exceeds the reservation.

| Lane step | Reserved work | Per-step detail |
| --- | ---: | --- |
| INV | 10 | One invalidated intent plus head removal/arming, allocator, authority cursor, and linked-account effects |
| DUE | 21 | Up to 16 child deletions, FIFO arm allocation, head arm, optional completed-link reopen, maintenance requeue allocation and head floor/queue update |
| RR | 21 | Up to 16 child deletions plus scan, arm, and associated updates |
| WIT | 16 | One group step or up to 16 witness rows pruned |
| AUTH | 8 | Up to eight unfiltered authority rows inspected; cursor advances to the last inspected row |

The shared charged-work budget is 110 and maintenance-head visits are capped
at 16 per invocation. WIT is capped at four steps, AUTH at 13 eight-row steps,
and RR and DUE at five steps each; INV is capped at 16 visits. These are shared
ceilings, not independent quotas.

At most 18 changed rows are reserved for metadata: one singleton initialization,
six maintenance-cursor finalizations (RR, WIT, and AUTH once in each phase),
ten lane-counter upserts, and one lane-turn update. Each cursor, counter, initialization and lane-turn statement reserves at most one
metadata write and measures its actual SQLite change delta before commit. Spare
unit allowance cannot cover metadata expansion. Cursor and counter writes
are in the lane transaction. Empty initialized runs write zero rows. The
combined charged-work and metadata ceilings are 128 changed rows. A failed
lane rolls back its data, cursor, and counter; earlier lane transactions remain
committed, and the next timer invocation starts with a fresh budget.

INV uses the existing partial authorization index and a full tuple seek on
`(link_id,generation,operation_id)`. The worker-bench exercises the production
query with 100, 1,000, and 10,000 direct-SQL rows, checks the indexed tuple
range and identical 51-opcode SQLite VM program, and verifies tail and miss
results. The old expanded-OR predicate remains as a negative plan control: it
uses the same prefix index but the plan cannot seek on the complete tuple.

These bounds cover the maintenance work shown here. The separate populated
six-table restore and complete transport matrix remain acceptance work; this
document does not claim whole finding01 closure.

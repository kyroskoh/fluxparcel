# ADR 0017 · Transfer filters and batch actions

## Decision

The Transfers page lists uploads and app-managed downloads together. It filters, searches, sorts and applies batch
actions in the browser over the jobs this device already tracks. No server API changes: each batch action calls the
same per-item operation as the item's own button, one item at a time.

| Control | Contract |
|---|---|
| Filters | All, Uploads, Downloads, Active, Queued, Paused, Completed and Failed, each with a count |
| Search | File name or conversation title, case-insensitive |
| Sort | Queue order (the order waiting transfers will start), newest first, largest first, or status |
| Selection | A checkbox per item and "Select all shown"; changing the filter clears the selection |
| Batch actions | Pause, Resume, Retry and Cancel apply to the selection, or to everything shown when nothing is selected |
| Clear finished | Removes completed and cancelled items from the list |

## Behavior

- **Per-item outcomes.** Each action applies to every eligible item on its own, using the same rules as the item's
  buttons, and skips the rest. A status message reports how many changed and why the others were skipped. A skipped
  or failing item never rolls back the others, and items that were not targeted keep running.
- **Resume never bypasses gates.** Resumed items rejoin the queue, where the network policy, concurrency limit and
  storage checks still apply.
- **Retry.** Retry applies to failed transfers. A download whose server copy changed still needs its own Restart,
  because restarting discards the bytes already saved.
- **Confirmation.** Cancel asks first and states that unfinished uploads are discarded and partial downloads deleted
  from this device. Clear finished asks first when it would delete verified downloads that have not been saved.
  Attachments in chats are never affected.
- **Reordering.** Move up and Move down appear only in queue order, where the list matches the start order.
- **Each transfer links to its conversation.**

## Fixes found while testing

- **Pause during start.** A pause that landed while a transfer waited for its Web Lock or storage estimate did not
  reach the worker, because an aborted signal never fires its event again. The download could finish in the
  background and show as verified after the pause. Uploads and downloads now check the signal before each stage.
- **Clear and reload.** Clearing a download removed its bytes before its record, so a reload straight after could
  restore the record. Records now go first, and restore deletes stored bytes that no record claims.

## Coverage

On desktop and mobile Chromium, browser tests throttle downloads across two conversations and cover the following:

- **Pause.** Searching by conversation and pausing everything shown leaves the other conversation's download running.
- **Mixed selection.** A selection that mixes eligible and ineligible items changes one and reports the skipped one.
- **Cancel.** Cancel asks first and removes only the selected download.
- **Retry.** A download failed by corrupted bytes is retried to a verified file.
- **Resume.** Resuming everything shown completes the paused downloads.
- **Clear finished.** It asks first, then leaves no download records or stored bytes in the browser, and the
  attachments stay in their chats.
- **Uploads.** An upload test pauses three throttled uploads as a batch, checks that no part is sent while paused,
  and resumes them to files with matching SHA-256.

## Still open

The history lives on each device and is not synchronised across devices. Uploads that finish in another tab show up
here only after that tab saves them.

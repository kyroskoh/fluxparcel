# ADR 0006 · Offline text outbox

Store up to 100 pending messages per account in IndexedDB. Commit a UUID, conversation, text, timestamp and retry state before showing a message as queued. The account must be checked with the server after a fresh load. Reconnect restores the route and resumes sending. Browsers can evict local storage, and sending runs only while an authenticated app tab is open.

Send one message at a time per account where Web Locks are supported. Other browsers may retry concurrently, using the same client message IDs and server idempotency. Preserve per-conversation order while transient errors are retried. A terminal failure can be retried or discarded, and later messages can continue. The API checks the expected sender against the current session as well as conversation membership. Acknowledgement removes the local entry.

Sign-out or account deletion purges pending text in the initiating browser and advances a local generation counter in one transaction. Tabs receive a stop signal where BroadcastChannel is available. The generation check also prevents a stale tab from adding messages after the purge. The service worker continues to cache only static assets.

# ADR 0003 · Contact approval and direct chats

Contact links share the invitation landing page and distinguish their scope with a public fragment prefix. The 256-bit secret remains opaque and only its hash is stored. Email-verified issuers can issue and revoke invitations. The default is one use and 15 minutes.

Acceptance records a pending request. Only the issuer may approve or decline it. Approval locks both accounts in UUID order and creates one direct conversation per unordered pair, including when two inverse requests are approved. Both participants use the existing membership checks and message cursor. Deleting either account deletes the direct conversation and its history.

An existing request does not consume a second invitation use. A consumed link can be retried by its original claimant. Issuer decisions are final for that request. Revocation prevents new requests on the link. The issuer can still decline requests already submitted.

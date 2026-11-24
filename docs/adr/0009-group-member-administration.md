# ADR 0009 · Group member administration

Any group member can list the group's members and roles. Changes follow fixed rules:

| Action | Owner | Admin | Member |
| --- | --- | --- | --- |
| Promote a member to admin, demote an admin | Yes | No | No |
| Remove an admin | Yes | No | No |
| Remove a member | Yes | Yes | No |
| Leave the group | No | Yes | Yes |

The owner's role cannot change, and the owner cannot leave. Ownership transfer is not implemented yet, and deleting the owner's account still deletes the group. Direct chats have no administration endpoints. Non-members, unknown groups and direct chats all get the standard not-found response.

Every change runs in one transaction that first locks the conversation row. Invitation redemption takes the same lock, so role changes, removals and joins cannot interleave. Each request body is read before the lock is taken.

A removal is recorded in `group_removals`. Redemption checks it after the existing-member shortcut, so a removed account cannot rejoin through any invitation, including multi-use links issued before the removal. There is no way to undo a removal yet. Leaving is voluntary and records nothing, so the account can rejoin with a valid invitation. When an admin is demoted, removed or leaves, the API revokes the open invitations that account issued. Invitations from the owner and other admins remain valid.

After a change, the API publishes the conversation change notice. Each open WebSocket rechecks membership on that notice, so a removed account's live view closes and its next synchronization returns not found. Messages a former member sent remain in the history.

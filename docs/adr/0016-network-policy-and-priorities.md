# ADR 0016 · Network policy, priorities and concurrency

## Decision

Uploads and app-managed downloads share one device-level policy and one ranking rule. Settings are kept per account
on each device in `localStorage`, apply at once in every open tab, and are cleared on sign-out.

| Setting | Default | Contract |
|---|---|---|
| Network policy | Ask | Any network; ask before transfers over 100 MiB on cellular or unknown networks; or Wi-Fi only |
| Uploads at a time | 3 | 1–5 per tab |
| Downloads at a time | 3 | 1–5 per tab |
| Priority | Normal | High, Normal or Low per transfer; FIFO within a priority |
| Aging | 10 minutes | Each 10 minutes of waiting is worth one priority level |

## Network detection

The browser's Network Information API is the only signal. `wifi` and `ethernet` count as Wi-Fi; `cellular`, `wimax`
and `bluetooth` count as cellular; anything else, including a browser that does not expose the API, is unknown. The
app never labels an unknown network as Wi-Fi, and it says when the browser does not report the type. Most desktop
browsers and Safari report nothing, so on those the Wi-Fi only policy holds every transfer until the user allows it.

## Behavior

- **Held, not failed.** A transfer the policy holds is `waiting` with the reason shown, and it does not take a slot,
  so held work never blocks the rest of the queue. Nothing is requested while it waits.
- **Rechecked on change.** A network change or a settings change in any tab re-applies the policy. A running
  transfer that becomes disallowed stops with its committed parts or bytes kept, and continues once the network or
  policy allows it again. Manual pause stays sticky and is never lifted by a network change.
- **Explicit override.** "Upload on this network" or "Download on this network" asks for confirmation, names the file
  and its remaining size, and warns about data charges. The consent is stored on that one transfer only.
- **Remaining bytes.** The 100 MiB threshold applies to the bytes still to transfer, so a nearly finished download
  is not held by the size of the whole file.
- **Ranking.** A waiting job's rank is the time it joined the queue plus 10 minutes for Normal or 20 minutes for Low.
  The lowest rank starts first. Jobs are FIFO within a priority, and a Low job that has waited 20 minutes starts
  before a High job queued just now. Files chosen together get strictly increasing queue times, so they keep their
  selection order.
- **Reordering.** Move up and Move down apply to jobs that have not started. A moved job takes its neighbour's priority
  and a queue time one millisecond before or after it. Changing priority or order never interrupts a running job.

## Coverage

Browser tests replace the Network Information API to switch between Wi-Fi, cellular and unknown networks on the
desktop and mobile profiles. They check that Wi-Fi only sends no request on cellular, starts on Wi-Fi, holds a
download mid-transfer when the device returns to cellular, and resumes it with `Range` to a verified file. They also
check that a declined override changes nothing and an accepted one sends the upload with a matching SHA-256. On an
unknown network, a 1 MiB download runs at once and a 101 MiB download asks first. The queue test runs one download at
a time and checks the start order after a priority change, a manual move and 25 minutes of aging on a fake clock.
An upload test confirms that no more than the configured two uploads send at once.

## Still open

- **Per tab.** Limits apply per tab; a shared scheduler across tabs is open. Web Locks still keep each transfer to one
  tab.
- **Not yet built.** Roaming, metered Wi-Fi and captive portals cannot be detected in browsers. Data budgets,
  bandwidth caps and fairness between conversations are also open.
- **Native downloads.** Downloads handled by the browser's own download manager are outside the policy.

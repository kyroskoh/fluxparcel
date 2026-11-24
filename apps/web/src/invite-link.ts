export const inviteFragment = /^#(?:contact_)?[\w-]{43}$/

export function invitePath(value: string, origin: string): string | null {
  if (value.length > 2048) return null
  try {
    const link = new URL(value.trim())
    if (link.origin !== origin || link.username || link.password || link.pathname !== '/i'
      || link.search || !inviteFragment.test(link.hash)) return null
    return '/i' + link.hash
  } catch {
    return null
  }
}

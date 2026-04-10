// Session state is owned by <SessionProvider> so every consumer shares the
// same store. This file is kept as a backwards-compatible re-export so the
// existing `from '../hooks/useSession'` imports keep working.
//
// See src/renderer/contexts/SessionContext.tsx for the actual implementation
// and the rationale (fixes the duplicate-hook-instance bug where clicking a
// session in SessionSwitcher never propagated to App's activeSession).
export { useSession, SessionProvider } from '../contexts/SessionContext'
export type { Session } from '../contexts/SessionContext'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_CONFIG } from '../config'
import {
  formatAuthName,
  isAdminUser,
  issueTvToken,
  isProductionMode,
  signInWithGoogle,
  signOut,
  subscribeAuth,
} from '../services/attendanceService'

function buildQrUrl(token) {
  const url = `${window.location.origin}/employee?t=${token}`
  return `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(url)}`
}

export function TvPage() {
  const [user, setUser] = useState(null)
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(APP_CONFIG.tokenRefreshSeconds)
  const production = isProductionMode()

  const loadToken = useCallback(async () => {
    try {
      setError('')
      const result = await issueTvToken(user)
      setPayload(result)
      const diff = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000))
      setSecondsLeft(diff)
    } catch (err) {
      setError(err.message)
    }
  }, [user])

  useEffect(() => subscribeAuth(setUser), [])

  useEffect(() => {
    if (production && (!user || !isAdminUser(user))) {
      return () => {}
    }

    const bootstrap = setTimeout(() => {
      loadToken()
    }, 0)

    const timer = setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          loadToken()
          return APP_CONFIG.tokenRefreshSeconds
        }

        return current - 1
      })
    }, 1000)

    return () => {
      clearInterval(timer)
      clearTimeout(bootstrap)
    }
  }, [loadToken, user, production])

  const checkInUrl = useMemo(() => {
    if (!payload?.token) return ''
    return `${window.location.origin}/employee?t=${payload.token}`
  }, [payload])

  const progress = Math.max(0, Math.min(100, (secondsLeft / APP_CONFIG.tokenRefreshSeconds) * 100))

  return (
    <main className="layout tv-layout premium-tv">
      <section className="tv-shell">
        <h1>WYBE FASHION</h1>
        <p className="tv-sub">Employee Attendance Portal</p>

        {production && !user && (
          <section className="card tv-auth-card">
            <h2>TV Admin Login</h2>
            <p className="muted">Sign in once on this TV browser to enable rotating QR.</p>
            <button onClick={signInWithGoogle}>Continue with Google</button>
          </section>
        )}

        {production && user && !isAdminUser(user) && (
          <section className="card tv-auth-card">
            <h2>Admin Role Required</h2>
            <p className="muted">
              Signed in as {formatAuthName(user)}. Set role `admin` in `employees/{user.uid}`.
            </p>
            <button className="ghost" onClick={signOut}>
              Sign out
            </button>
          </section>
        )}

        {payload?.token && (!production || (user && isAdminUser(user))) && (
          <section className="card tv-main-card">
            <div className="inline-pills">
              <span className="pill neutral">{new Date().toLocaleDateString()}</span>
              <span className="pill ok">Valid for {secondsLeft}s</span>
            </div>

            <img src={buildQrUrl(payload.token)} alt="Attendance QR" className="qr-image tv-qr" />

            <div className="progress-wrap">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>

            <p className="token">{payload.token}</p>
            <p className="muted">Fallback URL: <code>{checkInUrl}</code></p>

            <div className="row gap center">
              <button className="ghost" onClick={loadToken}>Refresh Token</button>
            </div>
          </section>
        )}

        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  )
}

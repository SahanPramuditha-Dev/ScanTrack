import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_CONFIG } from '../config'
import {
  clearTvDisplaySessionToken,
  getStoredTvDisplaySessionToken,
  getTvDisplaySessionFromUrl,
  formatAuthName,
  getAdminLogs,
  getAdminSettings,
  getEmployees,
  isAdminUser,
  issueTvToken,
  isProductionMode,
  saveTvDisplaySessionToken,
  signInWithGoogle,
  signOut,
  subscribeAuth,
} from '../services/attendanceService'

function buildQrUrl(token) {
  const url = `${window.location.origin}/employee?t=${token}`
  return `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${encodeURIComponent(url)}`
}

function formatClock(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}

function buildShiftBase(date, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number)
  return new Date(`${date}T${String(h || 0).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}:00`)
}

function summarizeDelta(minutes, earlyLabel, lateLabel, onTimeLabel) {
  if (minutes === 0) {
    return { label: onTimeLabel, mins: '0m' }
  }
  if (minutes < 0) {
    return { label: earlyLabel, mins: `${Math.abs(minutes)}m` }
  }
  return { label: lateLabel, mins: `${minutes}m` }
}

export function TvPage() {
  const [user, setUser] = useState(null)
  const [payload, setPayload] = useState(null)
  const [error, setError] = useState('')
  const [displaySessionToken, setDisplaySessionToken] = useState(() => getTvDisplaySessionFromUrl() || getStoredTvDisplaySessionToken())
  const [secondsLeft, setSecondsLeft] = useState(Math.max(60, APP_CONFIG.tokenRefreshSeconds))
  const [refreshSeconds, setRefreshSeconds] = useState(Math.max(60, APP_CONFIG.tokenRefreshSeconds))
  const [clockNow, setClockNow] = useState(new Date())
  const [recentEvents, setRecentEvents] = useState([])
  const [tvSettings, setTvSettings] = useState({
    workStart: APP_CONFIG.workStart,
    workEnd: '18:00',
  })
  const production = isProductionMode()
  const hasDisplaySession = Boolean(displaySessionToken)

  const loadToken = useCallback(async () => {
    try {
      setError('')
      const result = await issueTvToken(
        hasDisplaySession
          ? { displaySessionToken, user: null }
          : user,
        refreshSeconds,
      )
      setPayload(result)
      const diff = Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000))
      setSecondsLeft(diff)
      setRefreshSeconds(Math.max(60, Number(result.expiresAtMs ? Math.round((result.expiresAtMs - result.issuedAtMs) / 1000) : APP_CONFIG.tokenRefreshSeconds)))
    } catch (err) {
      setError(err.message)
    }
  }, [displaySessionToken, hasDisplaySession, refreshSeconds, user])

  useEffect(() => subscribeAuth(setUser), [])

  useEffect(() => {
    const fromUrl = getTvDisplaySessionFromUrl()
    if (!fromUrl) return
    setDisplaySessionToken(fromUrl)
    saveTvDisplaySessionToken(fromUrl)
    const params = new URLSearchParams(window.location.search)
    params.delete('ds')
    const nextQuery = params.toString()
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`
    window.history.replaceState({}, '', nextUrl)
  }, [])

  useEffect(() => {
    if (!displaySessionToken) {
      clearTvDisplaySessionToken()
      return
    }
    saveTvDisplaySessionToken(displaySessionToken)
  }, [displaySessionToken])

  useEffect(() => {
    if (!hasDisplaySession && production && (!user || !isAdminUser(user))) {
      return () => {}
    }

    const bootstrap = setTimeout(() => {
      loadToken()
    }, 0)

    const timer = setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          loadToken()
          return refreshSeconds
        }

        return current - 1
      })
    }, 1000)

    return () => {
      clearInterval(timer)
      clearTimeout(bootstrap)
    }
  }, [hasDisplaySession, loadToken, user, production, refreshSeconds])

  useEffect(() => {
    const timer = setInterval(() => setClockNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (hasDisplaySession || (production && (!user || !isAdminUser(user)))) {
      setRecentEvents([])
      return () => {}
    }

    let stopped = false

    const loadActivity = async () => {
      try {
        const [logs, employees, settings] = await Promise.all([
          getAdminLogs(),
          getEmployees(),
          getAdminSettings(),
        ])
        if (stopped) return

        setTvSettings((old) => ({ ...old, ...settings }))

        const employeesById = new Map(employees.map((employee) => [employee.id || employee.userId, employee]))
        const byUserDate = new Map()
        logs.forEach((item) => {
          const key = `${item.userId || 'unknown'}_${item.date || ''}`
          if (!byUserDate.has(key)) byUserDate.set(key, [])
          byUserDate.get(key).push(item)
        })
        byUserDate.forEach((items) => {
          items.sort((a, b) => String(a.clientTs || '').localeCompare(String(b.clientTs || '')))
        })

        const events = logs
          .filter((log) => log.action === 'checkIn' || log.action === 'checkOut')
          .slice(0, 12)
          .map((log) => {
            const employee = employeesById.get(log.userId) || {}
            const date = log.date || new Date(log.clientTs || Date.now()).toISOString().slice(0, 10)
            const actionAt = new Date(log.clientTs)

            if (log.action === 'checkIn') {
              const startBase = buildShiftBase(date, settings.workStart || APP_CONFIG.workStart)
              const diff = Math.round((actionAt.getTime() - startBase.getTime()) / 60000)
              const note = summarizeDelta(diff, 'Early Check-In', 'Late Check-In', 'On-Time Check-In')
              return {
                id: log.id,
                action: 'Check-In',
                name: log.employeeName || 'Employee',
                email: employee.email || '-',
                actionTime: formatClock(log.clientTs),
                noteLabel: note.label,
                noteMins: note.mins,
                detail: `At ${formatClock(log.clientTs)}`,
              }
            }

            const endBase = buildShiftBase(date, settings.workEnd || '18:00')
            const outDiff = Math.round((actionAt.getTime() - endBase.getTime()) / 60000)
            const outNote = summarizeDelta(outDiff, 'Early Check-Out', 'Late Check-Out', 'On-Time Check-Out')

            const chain = byUserDate.get(`${log.userId || 'unknown'}_${date}`) || []
            const checkInLog = [...chain]
              .filter((item) => item.action === 'checkIn' && item.clientTs && item.clientTs <= log.clientTs)
              .sort((a, b) => String(b.clientTs).localeCompare(String(a.clientTs)))[0]

            return {
              id: log.id,
              action: 'Check-Out',
              name: log.employeeName || 'Employee',
              email: employee.email || '-',
              actionTime: formatClock(log.clientTs),
              noteLabel: outNote.label,
              noteMins: outNote.mins,
              detail: `In ${formatClock(checkInLog?.clientTs)} | Out ${formatClock(log.clientTs)}`,
            }
          })

        setRecentEvents(events)
      } catch (err) {
        if (!stopped) {
          setError((old) => old || err.message)
        }
      }
    }

    loadActivity()
    const timer = setInterval(loadActivity, 8000)

    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [hasDisplaySession, production, user])

  const checkInUrl = useMemo(() => {
    if (!payload?.token) return ''
    return `${window.location.origin}/employee?t=${payload.token}`
  }, [payload])

  const progress = Math.max(0, Math.min(100, (secondsLeft / Math.max(1, refreshSeconds)) * 100))
  const todayLabel = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const canRenderDisplay = Boolean(payload?.token) && (hasDisplaySession || !production || (user && isAdminUser(user)))

  const disconnectDisplay = () => {
    setPayload(null)
    setDisplaySessionToken('')
    clearTvDisplaySessionToken()
    setError('')
  }

  return (
    <main className="layout tv-layout premium-tv tv-display-layout">
      <section className="tv-shell tv-display-shell">
        <div className="tv-grid-bg" aria-hidden="true" />
        <h1 className="tv-display-title">WYBE FASHION</h1>
        <p className="tv-display-sub">EMPLOYEE ATTENDANCE - CHECK-IN SYSTEM</p>

        {production && !hasDisplaySession && !user && (
          <section className="card tv-auth-card">
            <h2>TV Admin Login</h2>
            <p className="muted">Prefer using the copied TV link from admin. Manual admin login should only be used on private devices.</p>
            <button onClick={signInWithGoogle}>Continue with Google</button>
          </section>
        )}

        {production && !hasDisplaySession && user && !isAdminUser(user) && (
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

        {hasDisplaySession && (
          <section className="card tv-auth-card">
            <div className="row between wrap">
              <div>
                <h2>TV Display Session Active</h2>
                <p className="muted">This browser can show rotating QR codes without admin access.</p>
              </div>
              <button className="ghost" onClick={disconnectDisplay}>Disconnect TV Session</button>
            </div>
          </section>
        )}

        {canRenderDisplay && (
          <section className="card tv-main-card tv-display-card">
            <div className="tv-display-meta">
              <span className="tv-pill tv-pill-date">Date {todayLabel}</span>
              <span className="tv-pill tv-pill-active">QR Active</span>
            </div>

            <img src={buildQrUrl(payload.token)} alt="Attendance QR" className="qr-image tv-qr tv-display-qr" />

            <div className="progress-wrap tv-display-progress-wrap">
              <div className="progress-bar tv-display-progress" style={{ width: `${progress}%` }} />
            </div>

            <p className="tv-display-hint">Scan with your <strong>phone camera</strong> - no app needed</p>
            <p className="tv-display-token-chip">Token: {payload.token}</p>

            <div className="row gap center tv-display-refresh-row">
              <button className="ghost" onClick={loadToken}>Refresh Token</button>
              <span className="muted">Valid for {secondsLeft}s</span>
            </div>
          </section>
        )}

        {canRenderDisplay && (
          <div className="tv-display-footer">
            <span className="tv-display-clock">
              {clockNow.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </span>
            <span className="tv-display-live">LIVE</span>
            <span className="tv-display-note">QR refreshes automatically</span>
          </div>
        )}

        {canRenderDisplay && !hasDisplaySession && (
          <section className="card tv-activity-card">
            <div className="row between">
              <h3>Recent Attendance Activity</h3>
              <span className="muted">Start {tvSettings.workStart || APP_CONFIG.workStart} | End {tvSettings.workEnd || '18:00'}</span>
            </div>
            <div className="tv-activity-list">
              {recentEvents.length ? (
                recentEvents.map((event) => (
                  <article key={event.id} className="tv-activity-row">
                    <div className="tv-activity-top">
                      <strong>{event.name}</strong>
                      <span className={`tv-activity-tag ${event.action === 'Check-In' ? 'in' : 'out'}`}>{event.action}</span>
                    </div>
                    <div className="tv-activity-meta">
                      <span>{event.email}</span>
                      <span>{event.actionTime}</span>
                    </div>
                    <div className="tv-activity-note">
                      <span>{event.noteLabel}</span>
                      <span>{event.noteMins}</span>
                    </div>
                    <div className="tv-activity-sub">{event.detail}</div>
                  </article>
                ))
              ) : (
                <p className="muted">No recent check-ins or check-outs yet.</p>
              )}
            </div>
          </section>
        )}

        {error && <p className="error-text">{error}</p>}
        {payload?.token && (
          <p className="tv-display-fallback muted">Fallback URL: <code>{checkInUrl}</code></p>
        )}
      </section>
    </main>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { APP_CONFIG } from '../config'
import { humanDateTime } from '../lib/time'
import {
  demoSignIn,
  formatAuthName,
  formatRole,
  getEmployeeHistory,
  getEmployeeToday,
  getTokenFromUrl,
  isProductionMode,
  signInWithGoogle,
  signOut,
  submitAttendance,
  subscribeAuth,
} from '../services/attendanceService'

function StatusPill({ tone, children }) {
  return <span className={`pill ${tone}`}>{children}</span>
}

export function EmployeePage() {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(getTokenFromUrl())
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
  const [nextAction, setNextAction] = useState('checkIn')

  useEffect(() => subscribeAuth(setUser), [])

  useEffect(() => {
    if (!user) {
      setRecord(null)
      setHistory([])
      setNextAction('checkIn')
      return
    }

    const load = async () => {
      const uid = user.uid || user.id
      const [snapshot, lastDays] = await Promise.all([
        getEmployeeToday(uid),
        getEmployeeHistory(uid, 7),
      ])
      setRecord(snapshot.record)
      setNextAction(snapshot.nextAction)
      setHistory(lastDays)
    }

    load().catch((err) => setError(err.message))
  }, [user])

  const canSubmit = user && token && nextAction !== 'complete'

  const actionLabel = useMemo(() => {
    if (nextAction === 'checkOut') return 'Check-Out'
    if (nextAction === 'complete') return 'Completed'
    return 'Check-In'
  }, [nextAction])

  const handleDemoLogin = async (event) => {
    event.preventDefault()
    setError('')
    setMessage('')

    if (!email.trim()) {
      setError('Enter your work email address.')
      return
    }

    setLoading(true)
    try {
      await demoSignIn(email)
      setMessage('Signed in successfully.')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setError('')
    setMessage('')
    setLoading(true)

    try {
      await signInWithGoogle()
      setMessage('Signed in successfully.')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const refreshEmployee = async () => {
    if (!user) return
    const uid = user.uid || user.id
    const [snapshot, lastDays] = await Promise.all([
      getEmployeeToday(uid),
      getEmployeeHistory(uid, 7),
    ])
    setRecord(snapshot.record)
    setNextAction(snapshot.nextAction)
    setHistory(lastDays)
  }

  const handleSubmit = async () => {
    if (!canSubmit) return

    setError('')
    setMessage('')
    setLoading(true)

    try {
      const result = await submitAttendance({
        user,
        token: token.trim().toUpperCase(),
        action: nextAction,
      })
      setMessage(result.message)
      await refreshEmployee()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleSignOut = async () => {
    await signOut()
    setMessage('Signed out.')
  }

  return (
    <main className="layout scan-layout">
      <section className="scan-header card">
        <div>
          <p className="eyebrow">{APP_CONFIG.companyName}</p>
          <h1>Employee Attendance</h1>
          <p>Scan the TV QR and confirm your time in or time out.</p>
        </div>
        <div className="inline-pills">
          <StatusPill tone="neutral">Mode: {isProductionMode() ? 'Firebase' : 'Demo Local'}</StatusPill>
          <StatusPill tone="neutral">Branch: {APP_CONFIG.branchId}</StatusPill>
        </div>
      </section>

      {!user ? (
        <section className="card scan-card">
          <h2>Sign in</h2>
          {isProductionMode() ? (
            <button onClick={handleGoogleLogin} disabled={loading}>
              Continue with Google
            </button>
          ) : (
            <form onSubmit={handleDemoLogin} className="stack">
              <input
                type="email"
                placeholder="you@wybefashion.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <button type="submit" disabled={loading}>
                Sign in
              </button>
              <p className="muted">Demo: admin@wybefashion.com, nadeesha@wybefashion.com</p>
            </form>
          )}
        </section>
      ) : (
        <>
          <section className="card scan-card">
            <div className="row between">
              <div>
                <h2>{formatAuthName(user)}</h2>
                <p className="muted">Role: {formatRole(user)}</p>
              </div>
              <button className="ghost" onClick={handleSignOut}>
                Sign out
              </button>
            </div>

            <div className="token-strip">
              <span className="token-text">Token: {token || 'Missing'}</span>
              <input
                aria-label="Token"
                placeholder="Token from TV"
                value={token}
                onChange={(event) => setToken(event.target.value.toUpperCase())}
              />
            </div>

            <div className={`work-status ${record?.checkInAt && !record?.checkOutAt ? 'in' : 'out'}`}>
              <span>{record?.checkInAt ? 'Checked In' : 'Awaiting Check-In'}</span>
              <span>{record?.checkInAt ? humanDateTime(record.checkInAt) : '-'}</span>
            </div>

            <button className={`big-btn ${nextAction === 'checkIn' ? 'big-btn-in' : 'big-btn-out'}`} disabled={!canSubmit || loading} onClick={handleSubmit}>
              {loading ? 'Saving...' : actionLabel}
            </button>

            <div className="grid two compact">
              <p>Check-In: {record?.checkInAt ? humanDateTime(record.checkInAt) : '-'}</p>
              <p>Check-Out: {record?.checkOutAt ? humanDateTime(record.checkOutAt) : '-'}</p>
            </div>
          </section>

          <section className="card">
            <h3>Last 7 Days</h3>
            <div className="history-list">
              {history.length ? (
                history.map((item) => (
                  <div key={`${item.userId}-${item.date}`} className="history-item">
                    <strong>{item.date}</strong>
                    <span>{item.checkInAt ? humanDateTime(item.checkInAt) : '-'}</span>
                    <span>{item.checkOutAt ? humanDateTime(item.checkOutAt) : '-'}</span>
                    <span className={`pill ${item.late ? 'danger' : 'ok'}`}>{item.late ? 'Late' : 'On Time'}</span>
                  </div>
                ))
              ) : (
                <p className="muted">No history yet.</p>
              )}
            </div>
          </section>
        </>
      )}

      {(message || error) && (
        <section className="card">
          {message && <p className="success-text">{message}</p>}
          {error && <p className="error-text">{error}</p>}
        </section>
      )}
    </main>
  )
}

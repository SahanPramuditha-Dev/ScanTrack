import { useCallback, useEffect, useMemo, useState } from 'react'
import { APP_CONFIG } from '../config'
import { downloadCsv } from '../lib/csv'
import { formatDateKey, getTodayKey, humanDateTime, humanTime } from '../lib/time'
import { useToast } from '../components/useToast'
import { EmptyState } from '../components/EmptyState'
import { LoadingSpinner } from '../components/Loading'
import { DataTable } from '../components/DataTable'
import {
  demoSignIn,
  formatAuthName,
  formatRole,
  getEmployeeAttendanceForMonth,
  getEmployeeDailyPayments,
  getEmployeeSalaryEstimate,
  getEmployeeSalaryRecords,
  getEmployeeHistory,
  getEmployeeToday,
  getTokenFromUrl,
  isProductionMode,
  signInWithGoogle,
  signOut,
  submitAttendance,
  subscribeAuth,
} from '../services/attendanceService'

const DAY_MS = 24 * 60 * 60 * 1000

export function EmployeePage() {
  const toast = useToast()
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(getTokenFromUrl())
  const [urlToken, setUrlToken] = useState(getTokenFromUrl())
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState(null)
  const [history, setHistory] = useState([])
  const [nextAction, setNextAction] = useState('checkIn')
  const [gps, setGps] = useState(null)
  const [gpsState, setGpsState] = useState('idle')
  const [gpsMessage, setGpsMessage] = useState('Checking location...')
  const [tokenExpired, setTokenExpired] = useState(false)
  const [tokenExpiresIn, setTokenExpiresIn] = useState(null)
  const [salaryEstimate, setSalaryEstimate] = useState(null)
  const [salaryRecords, setSalaryRecords] = useState([])
  const [dailyPayments, setDailyPayments] = useState([])
  const [attendanceMonthRows, setAttendanceMonthRows] = useState([])
  const [selectedAttendanceDate, setSelectedAttendanceDate] = useState(getTodayKey())
  const [salaryMonth, setSalaryMonth] = useState(getTodayKey().slice(0, 7))
  const [attendanceMonth, setAttendanceMonth] = useState(getTodayKey().slice(0, 7))
  const [payrollLoading, setPayrollLoading] = useState(false)
  const [attendanceLoading, setAttendanceLoading] = useState(false)

  useEffect(() => subscribeAuth(setUser), [])

  useEffect(() => {
    const fromUrl = getTokenFromUrl()
    setUrlToken(fromUrl)
    if (fromUrl) {
      setToken(fromUrl)
      setTokenExpired(false)
      setTokenExpiresIn(APP_CONFIG.tokenRefreshSeconds)
    }
  }, [])

  useEffect(() => {
    if (!user) {
      setRecord(null)
      setHistory([])
      setNextAction('checkIn')
      setSalaryEstimate(null)
      setSalaryRecords([])
      setDailyPayments([])
      setAttendanceMonthRows([])
      setAttendanceMonth(getTodayKey().slice(0, 7))
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

    load().catch((err) => toast.addToast(err.message, 'error'))
  }, [user, toast])

  useEffect(() => {
    if (!user) return

    let cancelled = false
    const loadPayroll = async () => {
      const uid = user.uid || user.id
      setPayrollLoading(true)
      try {
        const [estimate, records, payments] = await Promise.all([
          getEmployeeSalaryEstimate(uid, salaryMonth).catch(() => null),
          getEmployeeSalaryRecords(uid, 24).catch(() => []),
          getEmployeeDailyPayments(uid, salaryMonth).catch(() => []),
        ])
        if (cancelled) return
        setSalaryEstimate(estimate)
        setSalaryRecords(records)
        setDailyPayments(payments)
      } catch (err) {
        if (!cancelled) {
          toast.addToast(err.message, 'error')
        }
      } finally {
        if (!cancelled) {
          setPayrollLoading(false)
        }
      }
    }

    loadPayroll()

    return () => {
      cancelled = true
    }
  }, [user, salaryMonth, toast])

  useEffect(() => {
    if (!user) return

    let cancelled = false
    const loadAttendanceMonth = async () => {
      const uid = user.uid || user.id
      setAttendanceLoading(true)
      try {
        const attendanceRows = await getEmployeeAttendanceForMonth(uid, attendanceMonth).catch(() => [])
        if (cancelled) return
        setAttendanceMonthRows(attendanceRows)
        setSelectedAttendanceDate(attendanceRows[0]?.date || `${attendanceMonth}-01`)
      } catch (err) {
        if (!cancelled) {
          toast.addToast(err.message, 'error')
        }
      } finally {
        if (!cancelled) {
          setAttendanceLoading(false)
        }
      }
    }

    loadAttendanceMonth()

    return () => {
      cancelled = true
    }
  }, [attendanceMonth, user, toast])

  const captureGps = useCallback(({ highAccuracy = false } = {}) => new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not available in this browser.'))
      return
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          lat: Number(position.coords.latitude),
          lng: Number(position.coords.longitude),
          accuracy: Number(position.coords.accuracy || 0),
          capturedAt: new Date().toISOString(),
        })
      },
      (geoError) => {
        reject(geoError)
      },
      { enableHighAccuracy: highAccuracy, timeout: highAccuracy ? 12000 : 7000, maximumAge: 0 },
    )
  }), [])

  useEffect(() => {
    if (!user) {
      setGps(null)
      setGpsState('idle')
      setGpsMessage('Sign in to verify your location.')
      return
    }

    setGpsState('checking')
    setGpsMessage('Checking location...')
    captureGps()
      .then((nextGps) => {
        setGps(nextGps)
        setGpsState('ready')
        setGpsMessage(`Location ready | ${nextGps.lat.toFixed(5)}, ${nextGps.lng.toFixed(5)}`)
      })
      .catch((geoError) => {
        setGps(null)
        setGpsState('blocked')
        if (geoError?.code === 1) {
          setGpsMessage('Location permission is blocked. Allow location access, then try again.')
          return
        }
        if (geoError?.code === 2) {
          setGpsMessage('Could not detect your location. Move to an open area and try again.')
          return
        }
        setGpsMessage('Location unavailable. Turn on GPS and try again.')
      })
  }, [captureGps, user])

  useEffect(() => {
    if (tokenExpiresIn == null || tokenExpiresIn <= 0) return undefined
    const timer = setInterval(() => {
      setTokenExpiresIn((current) => {
        if (current == null) return null
        return Math.max(0, current - 1)
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [tokenExpiresIn])

  const canSubmit = user && token && nextAction !== 'complete'
  const canCheckIn = canSubmit && nextAction === 'checkIn'
  const canCheckOut = canSubmit && nextAction === 'checkOut'
  const gpsLabel = gps ? `${gps.lat.toFixed(5)},${gps.lng.toFixed(5)}` : ''
  const gpsDotClass = gpsState === 'ready' ? 'gps-ok-dot' : gpsState === 'checking' ? 'gps-pending-dot' : 'gps-miss-dot'

  const inviteEmail = (() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('i')?.trim().toLowerCase() || ''
  })()

  const handleDemoLogin = async (event) => {
    event.preventDefault()

    const loginEmail = inviteEmail || email
    if (!loginEmail.trim()) {
      toast.addToast('Enter your work email address or use invite link.', 'warning')
      return
    }

    setLoading(true)
    try {
      await demoSignIn(loginEmail)
      toast.addToast('Signed in successfully.', 'success')
    } catch (err) {
      toast.addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleLogin = async () => {
    setLoading(true)

    try {
      await signInWithGoogle()
      toast.addToast('Signed in successfully.', 'success')
    } catch (err) {
      toast.addToast(err.message, 'error')
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

  const handleSubmit = async (action) => {
    if (!canSubmit || action !== nextAction) return

    setLoading(true)
    setGpsState('checking')
    setGpsMessage('Refreshing location for secure check-in...')

    try {
      let currentGps = gps
      try {
        currentGps = await captureGps({ highAccuracy: true })
        setGps(currentGps)
        setGpsState('ready')
        setGpsMessage(`Live location confirmed | ${currentGps.lat.toFixed(5)}, ${currentGps.lng.toFixed(5)}`)
      } catch {
        currentGps = null
        setGps(null)
        setGpsState('blocked')
        setGpsMessage('Could not refresh your location. Enable location access and try again.')
      }

      const result = await submitAttendance({
        user: { ...user, gps: currentGps },
        token: token.trim().toUpperCase(),
        action,
      })
      setTokenExpired(false)
      toast.addToast(result.message, 'success')
      await refreshEmployee()
      const uid = user.uid || user.id
      const attendanceRows = await getEmployeeAttendanceForMonth(uid, attendanceMonth).catch(() => [])
      setAttendanceMonthRows(attendanceRows)
      setSelectedAttendanceDate(getTodayKey())
    } catch (err) {
      if (String(err?.message || '').toLowerCase().includes('expired')) {
        setTokenExpired(true)
        setTokenExpiresIn(0)
      }
      toast.addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleRefreshGps = async () => {
    if (!user) return

    setGpsState('checking')
    setGpsMessage('Refreshing location...')
    try {
      const nextGps = await captureGps({ highAccuracy: true })
      setGps(nextGps)
      setGpsState('ready')
      setGpsMessage(`Location ready | ${nextGps.lat.toFixed(5)}, ${nextGps.lng.toFixed(5)}`)
    } catch (geoError) {
      setGps(null)
      setGpsState('blocked')
      if (geoError?.code === 1) {
        setGpsMessage('Location permission is blocked. Allow location access, then try again.')
        return
      }
      if (geoError?.code === 2) {
        setGpsMessage('Could not detect your location. Move to an open area and try again.')
        return
      }
      setGpsMessage('Location unavailable. Turn on GPS and try again.')
    }
  }

  const handleSignOut = async () => {
    await signOut()
    toast.addToast('Signed out.', 'info')
  }

  const handleTokenChange = (value) => {
    setToken(value.toUpperCase())
    setTokenExpired(false)
  }

  const tokenMeta = useMemo(() => {
    if (!token.trim()) {
      return { tone: 'warn', label: 'Missing token' }
    }
    if (tokenExpired) {
      return { tone: 'bad', label: 'Expired token' }
    }
    return { tone: 'good', label: 'Valid token' }
  }, [token, tokenExpired])

  const workState = useMemo(() => {
    if (record?.checkInAt && !record?.checkOutAt) {
      return { label: 'Checked in today', icon: 'In', time: humanDateTime(record.checkInAt) }
    }
    if (record?.checkInAt && record?.checkOutAt) {
      return { label: 'Checked out for today', icon: 'Out', time: humanDateTime(record.checkOutAt) }
    }
    return { label: 'Not checked in today', icon: 'Idle', time: '-' }
  }, [record])

  const historyRows = useMemo(() => {
    const historyMap = new Map(history.map((item) => [item.date, item]))
    const today = new Date(`${getTodayKey()}T00:00:00`)
    return Array.from({ length: 7 }).map((_, idx) => {
      const dateObj = new Date(today.getTime() - idx * DAY_MS)
      const dateKey = formatDateKey(dateObj)
      const dayData = historyMap.get(dateKey)
      const label =
        idx === 0 ? 'Today' : idx === 1 ? 'Yest.' : dateObj.toLocaleDateString('en-US', { weekday: 'short' })
      const timeline = dayData?.checkInAt
        ? dayData?.checkOutAt
          ? `${new Date(dayData.checkInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} -> ${new Date(dayData.checkOutAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : new Date(dayData.checkInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '--'
      const status = dayData?.checkInAt ? (dayData.late ? 'Late' : 'On Time') : 'Absent'
      return {
        key: dateKey,
        label,
        timeline,
        status,
      }
    })
  }, [history])

  const salaryMonthRecords = useMemo(
    () => salaryRecords.filter((record) => String(record.month || '') === salaryMonth),
    [salaryRecords, salaryMonth],
  )

  const salaryMonthSummary = useMemo(() => {
    const totalPaid = salaryMonthRecords.reduce((sum, rec) => sum + Number(rec.finalSalary || 0), 0)
    const totalBase = salaryMonthRecords.reduce((sum, rec) => sum + Number(rec.baseSalary || 0), 0)
    const totalDeductions = salaryMonthRecords.reduce((sum, rec) => sum + Number(rec.deductions || 0), 0)
    const totalBonus = salaryMonthRecords.reduce((sum, rec) => sum + Number(rec.bonus || 0), 0)
    return {
      count: salaryMonthRecords.length,
      totalPaid,
      totalBase,
      totalDeductions,
      totalBonus,
    }
  }, [salaryMonthRecords])

  const dailyPaymentSummary = useMemo(() => {
    const totalDailySalary = dailyPayments.reduce((sum, rec) => sum + Number(rec.dailySalary || 0), 0)
    const totalDeductions = dailyPayments.reduce((sum, rec) => sum + Number(rec.totalDeductions || 0), 0)
    const totalNetPay = dailyPayments.reduce((sum, rec) => sum + Number(rec.netPay || 0), 0)
    return {
      count: dailyPayments.length,
      totalDailySalary,
      totalDeductions,
      totalNetPay,
    }
  }, [dailyPayments])

  const attendanceMonthMap = useMemo(
    () => new Map(attendanceMonthRows.map((row) => [row.date, row])),
    [attendanceMonthRows],
  )

  const selectedMonthDate = useMemo(() => new Date(`${attendanceMonth}-01T00:00:00`), [attendanceMonth])
  const daysInSelectedMonth = useMemo(
    () => new Date(selectedMonthDate.getFullYear(), selectedMonthDate.getMonth() + 1, 0).getDate(),
    [selectedMonthDate],
  )

  const attendanceMonthSummary = useMemo(() => {
    const present = attendanceMonthRows.filter((row) => row.checkInAt).length
    const absent = Math.max(0, daysInSelectedMonth - present)
    const late = attendanceMonthRows.filter((row) => row.late).length
    const overtimeMinutes = attendanceMonthRows.reduce((sum, row) => sum + Number(row.overtimeMinutes || 0), 0)
    const overtimeHours = attendanceMonthRows.reduce((sum, row) => sum + Number(row.overtimeHours || 0), 0)
    const overtimePay = attendanceMonthRows.reduce((sum, row) => sum + Number(row.overtimePay || 0), 0)
    return { present, late, overtimeMinutes, overtimeHours, overtimePay, absent }
  }, [attendanceMonthRows, daysInSelectedMonth])

  const calendarCells = useMemo(() => {
    const first = selectedMonthDate
    const startOffset = first.getDay()
    const cells = []
    for (let i = 0; i < startOffset; i += 1) {
      cells.push(null)
    }
    for (let day = 1; day <= daysInSelectedMonth; day += 1) {
      const dateObj = new Date(first.getFullYear(), first.getMonth(), day)
      const dateKey = dateObj.toISOString().slice(0, 10)
      const row = attendanceMonthMap.get(dateKey) || null
      const status = row?.checkInAt ? (row?.late ? 'late' : 'present') : 'absent'
      cells.push({
        dateKey,
        day,
        weekday: dateObj.toLocaleDateString('en-US', { weekday: 'short' }),
        row,
        status,
      })
    }
    return cells
  }, [attendanceMonthMap, daysInSelectedMonth, selectedMonthDate])

  const selectedAttendanceRecord = attendanceMonthMap.get(selectedAttendanceDate) || null
  const selectedAttendanceStatus = selectedAttendanceRecord?.checkInAt
    ? selectedAttendanceRecord.late
      ? 'Late'
      : 'Present'
    : 'Absent'

  const attendanceSummary = useMemo(() => {
    const checkedInDays = history.filter((item) => item.checkInAt).length
    const lateDays = history.filter((item) => item.late).length
    const checkedOutDays = history.filter((item) => item.checkOutAt).length
    const lastActivity = historyRows.find((row) => row.timeline && row.timeline !== '--') || null
    return {
      checkedInDays,
      lateDays,
      checkedOutDays,
      lastActivity: lastActivity?.timeline || '-',
    }
  }, [history, historyRows])

  const exportSalaryCsv = () => {
    if (!salaryMonthRecords.length) return
    downloadCsv(`my-salary-${salaryMonth}.csv`, salaryMonthRecords.map((rec) => ({
      Month: rec.month,
      'Final Salary': rec.finalSalary,
      Present: rec.daysPresent,
      Late: rec.lateDays,
      Base: rec.baseSalary,
      Deductions: rec.deductions,
      Bonus: rec.bonus,
      'Manual Days': rec.manualCount,
      Email: rec.email || '',
      UID: rec.userId,
    })))
  }

  const exportDailyPaymentsCsv = () => {
    if (!dailyPayments.length) return
    downloadCsv(`my-daily-payments-${salaryMonth}.csv`, dailyPayments.map((rec) => ({
      Date: rec.date,
      Employee: rec.employeeName,
      'Daily Salary': rec.dailySalary,
      'Total Deductions': rec.totalDeductions,
      'Net Pay': rec.netPay,
      Notes: rec.notes || '',
    })))
  }

  return (
    <main className="layout employee-layout">
      <section className="employee-brand">
        <h1>{APP_CONFIG.companyName.toUpperCase()}</h1>
        <p>ATTENDANCE PORTAL</p>
      </section>

      {!user ? (
        <section className="card employee-auth-card">
          <h2>Sign In</h2>
          <p className="muted">Continue to check-in and check-out with your attendance token.</p>
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
        <div className="employee-stack">
          <section className="card employee-hero-card">
            <div className="employee-user-left">
              <div className="employee-avatar">{formatAuthName(user).slice(0, 2).toUpperCase()}</div>
              <div className="employee-identity">
                <p className="eyebrow">Employee Profile</p>
                <h2>{formatAuthName(user)}</h2>
                <p className="muted employee-user-id">
                  {user?.uid || user?.id || '-'} - {formatRole(user)}
                </p>
              </div>
            </div>
            <button className="ghost employee-signout" onClick={handleSignOut}>
              Sign out
            </button>
          </section>

          <section className="stats-grid employee-metrics">
            <article className="card stat-card">
              <p>Checked In</p>
              <h3>{attendanceSummary.checkedInDays}</h3>
            </article>
            <article className="card stat-card">
              <p>Late Days</p>
              <h3>{attendanceSummary.lateDays}</h3>
            </article>
            <article className="card stat-card">
              <p>Payroll Entries</p>
              <h3>{salaryMonthSummary.count}</h3>
            </article>
            <article className="card stat-card">
              <p>Net Pay</p>
              <h3>{Number(dailyPaymentSummary.totalNetPay || salaryEstimate?.bestCaseFinalSalary || 0).toLocaleString()}</h3>
            </article>
          </section>

          <section className="employee-workgrid">
            <section className={`card employee-token-card token-${tokenMeta.tone}`}>
              <div className="employee-section-head">
                <div>
                  <p className="eyebrow">Access Token</p>
                  <h3>{tokenMeta.label}</h3>
                </div>
                <span className="muted employee-token-expiry">
                  Expires in {tokenExpiresIn == null ? '--' : `${tokenExpiresIn}s`}
                </span>
              </div>
              <div className="employee-token-input-wrap">
                <input
                  aria-label="Token"
                  placeholder="Token from TV"
                  value={token}
                  onChange={(event) => handleTokenChange(event.target.value)}
                />
              </div>
              {urlToken ? <p className="muted employee-token-hint">Auto token detected from QR URL.</p> : null}
            </section>

            <section className="card employee-action-card">
              <div className="employee-section-head">
                <div>
                  <p className="eyebrow">Attendance</p>
                  <h3>{workState.label}</h3>
                </div>
                <span className="employee-work-emoji" aria-hidden="true">
                  {workState.icon}
                </span>
              </div>
              <p className="muted employee-work-time">{workState.time}</p>

              <button
                className="employee-btn employee-btn-primary"
                disabled={!canCheckIn || loading}
                onClick={() => handleSubmit('checkIn')}
              >
                {loading && nextAction === 'checkIn' ? 'Saving...' : 'Check In'}
              </button>
              <button
                className="employee-btn employee-btn-secondary"
                disabled={!canCheckOut || loading}
                onClick={() => handleSubmit('checkOut')}
              >
                {loading && nextAction === 'checkOut' ? 'Saving...' : 'Check Out'}
              </button>

              <div className="employee-gps-line">
                <span className={gpsDotClass} />
                <span>{gps ? `Location verified - ${gpsLabel}` : gpsMessage}</span>
              </div>
              <p className="muted employee-gps-help">
                GPS is checked again when you tap check in or check out. If you are outside the allowed shop radius, attendance will be blocked.
              </p>
              <button type="button" className="employee-gps-refresh" onClick={handleRefreshGps} disabled={loading || gpsState === 'checking'}>
                {gpsState === 'checking' ? 'Checking location...' : 'Retry location'}
              </button>
            </section>
          </section>

          <section className="card employee-payroll-card">
            <div className="row between wrap employee-payroll-top">
              <div>
                <p className="eyebrow">My Payroll</p>
                <h2>{salaryMonth}</h2>
              </div>
              <div className="row gap wrap employee-payroll-actions">
                <label>
                  <input type="month" value={salaryMonth} onChange={(e) => setSalaryMonth(e.target.value)} />
                </label>
                <button type="button" className="ghost" onClick={exportSalaryCsv} disabled={!salaryMonthRecords.length}>
                  Export Salary
                </button>
                <button type="button" className="ghost" onClick={exportDailyPaymentsCsv} disabled={!dailyPayments.length}>
                  Export Daily
                </button>
              </div>
            </div>
            {payrollLoading ? <p className="muted">Loading payroll for {salaryMonth}...</p> : null}
            {salaryEstimate ? (
                <div className="employee-pay-summary">
                  <article className="employee-pay-hero">
                    <p>Projected Final</p>
                    <strong>{Number(salaryEstimate.bestCaseFinalSalary || 0).toLocaleString()}</strong>
                    <span>Based on current attendance and rules</span>
                  </article>
                  <article className="employee-pay-mini">
                    <p>Earned So Far</p>
                    <strong>{Number(salaryEstimate.earnedSoFar || 0).toLocaleString()}</strong>
                  </article>
                  <article className="employee-pay-mini">
                    <p>Daily Rate</p>
                    <strong>{Number(salaryEstimate.dailyRate || 0).toLocaleString()}</strong>
                  </article>
                  <article className="employee-pay-mini">
                    <p>OT Hours</p>
                    <strong>{Math.round(Number(salaryEstimate.overtimeHours || 0) * 100) / 100}</strong>
                  </article>
                  <article className="employee-pay-mini">
                    <p>OT Pay</p>
                    <strong>{Number(salaryEstimate.overtimePay || 0).toLocaleString()}</strong>
                  </article>
                  <article className="employee-pay-mini">
                    <p>Allowed Holidays</p>
                    <strong>{Number(salaryEstimate.allowedHolidays || 0)}</strong>
                  </article>
                </div>
              ) : null}
            {salaryMonthRecords.length ? (
              <div className="table-wrap employee-table-wrap">
                <DataTable
                  data={salaryMonthRecords}
                  columns={[
                    {
                      key: 'month',
                      header: 'Month',
                      sortable: true,
                    },
                    {
                      key: 'finalSalary',
                      header: 'Final',
                      render: (rec) => <strong>{Number(rec.finalSalary || 0).toLocaleString()}</strong>,
                      sortable: true,
                    },
                    {
                      key: 'daysPresent',
                      header: 'Present',
                      render: (rec) => rec.daysPresent,
                      sortable: true,
                    },
                    {
                      key: 'lateDays',
                      header: 'Late',
                      render: (rec) => rec.lateDays,
                      sortable: true,
                    },
                    {
                      key: 'overtimeHours',
                      header: 'OT Hrs',
                      render: (rec) => Math.round(Number(rec.overtimeHours || 0) * 100) / 100,
                      sortable: true,
                    },
                    {
                      key: 'overtimePay',
                      header: 'OT Pay',
                      render: (rec) => Number(rec.overtimePay || 0).toLocaleString(),
                      sortable: true,
                    },
                    {
                      key: 'baseSalary',
                      header: 'Base',
                      render: (rec) => Number(rec.baseSalary || 0).toLocaleString(),
                      sortable: true,
                    },
                    {
                      key: 'deductions',
                      header: 'Deductions',
                      render: (rec) => Number(rec.deductions || 0).toLocaleString(),
                      sortable: true,
                    },
                    {
                      key: 'bonus',
                      header: 'Bonus',
                      render: (rec) => Number(rec.bonus || 0).toLocaleString(),
                      sortable: true,
                    },
                  ]}
                  searchable={false}
                  paginated={false}
                  emptyMessage="No salary records available."
                  className="employee-salary-records-table"
                />
              </div>
            ) : (
              <EmptyState
                icon="💰"
                title="No salary records"
                description="Your monthly salary calculations will appear here once payroll is processed."
              />
            )}
            {dailyPayments.length ? (
              <div className="employee-daily-section">
                <div className="employee-section-head">
                  <div>
                    <p className="eyebrow">Daily Payments</p>
                    <h3>{dailyPaymentSummary.count} records</h3>
                  </div>
                  <p className="muted employee-daily-total">
                    Deductions {Number(dailyPaymentSummary.totalDeductions || 0).toLocaleString()}
                  </p>
                </div>
                <div className="table-wrap employee-table-wrap">
                  <DataTable
                    data={dailyPayments}
                    columns={[
                      {
                        key: 'date',
                        header: 'Date',
                        sortable: true,
                      },
                      {
                        key: 'dailySalary',
                        header: 'Daily Salary',
                        render: (rec) => Number(rec.dailySalary || 0).toLocaleString(),
                        sortable: true,
                      },
                      {
                        key: 'totalDeductions',
                        header: 'Deductions',
                        render: (rec) => Number(rec.totalDeductions || 0).toLocaleString(),
                        sortable: true,
                      },
                      {
                        key: 'netPay',
                        header: 'Net',
                        render: (rec) => <strong>{Number(rec.netPay || 0).toLocaleString()}</strong>,
                        sortable: true,
                      },
                      {
                        key: 'notes',
                        header: 'Notes',
                        render: (rec) => rec.notes || '-',
                        sortable: false,
                      },
                    ]}
                    searchable={false}
                    paginated={false}
                    emptyMessage="No daily payment records available."
                    className="employee-daily-payments-table"
                  />
                </div>
              </div>
            ) : null}
            <p className="muted employee-pay-note">
              Salary and daily payments are generated by admin from attendance. Contact admin if a record looks wrong.
            </p>
          </section>

          <section className="card employee-calendar-card">
            <div className="row between wrap employee-calendar-head">
              <div>
                <p className="eyebrow">Attendance Calendar</p>
                <h2>{attendanceMonth}</h2>
              </div>
              <div className="employee-calendar-summary">
                <span className="pill ok">Present {attendanceMonthSummary.present}</span>
                <span className="pill neutral">Absent {attendanceMonthSummary.absent}</span>
                <span className="pill neutral">Late {attendanceMonthSummary.late}</span>
                <span className="pill neutral">OT {Math.round(attendanceMonthSummary.overtimeHours * 100) / 100}h</span>
              </div>
            </div>
            <div className="row gap wrap employee-payroll-actions">
              <label>
                <input type="month" value={attendanceMonth} onChange={(e) => setAttendanceMonth(e.target.value)} />
              </label>
              {attendanceLoading ? <span className="muted">Loading attendance...</span> : null}
            </div>

            <div className="employee-calendar-grid employee-calendar-weekdays" aria-hidden="true">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>

            <div className="employee-calendar-grid">
              {calendarCells.map((cell, idx) => {
                if (!cell) {
                  return <div key={`blank-${idx}`} className="employee-calendar-cell empty" />
                }

                const isSelected = cell.dateKey === selectedAttendanceDate
                return (
                  <button
                    key={cell.dateKey}
                    type="button"
                    className={`employee-calendar-cell status-${cell.status} ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedAttendanceDate(cell.dateKey)}
                  >
                    <span className="employee-calendar-day">{cell.day}</span>
                    <span className="employee-calendar-status">
                      {cell.status === 'present' ? 'Present' : cell.status === 'late' ? 'Late' : 'Absent'}
                    </span>
                    <span className="employee-calendar-time">
                      In: {cell.row?.checkInAt ? humanTime(new Date(cell.row.checkInAt)) : '--'}
                    </span>
                    <span className="employee-calendar-time">
                      Out: {cell.row?.checkOutAt ? humanTime(new Date(cell.row.checkOutAt)) : '--'}
                    </span>
                    {Number(cell.row?.overtimeMinutes || 0) > 0 ? (
                      <span className="employee-calendar-overtime">
                        {cell.row.overtimeLabel || 'OT'} {Math.round((Number(cell.row.overtimeHours || 0)) * 100) / 100}h
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>

            <div className="employee-calendar-detail">
              <div>
                <p className="eyebrow">{selectedAttendanceDate}</p>
                <h3>{selectedAttendanceStatus}</h3>
              </div>
              <div className="employee-calendar-detail-grid">
                <article>
                  <span>Check In</span>
                  <strong>{selectedAttendanceRecord?.checkInAt ? humanDateTime(selectedAttendanceRecord.checkInAt) : '--'}</strong>
                </article>
                <article>
                  <span>Check Out</span>
                  <strong>{selectedAttendanceRecord?.checkOutAt ? humanDateTime(selectedAttendanceRecord.checkOutAt) : '--'}</strong>
                </article>
                <article>
                  <span>Worked</span>
                  <strong>{Number(selectedAttendanceRecord?.workedMinutes || 0) ? `${Math.round(Number(selectedAttendanceRecord.workedMinutes || 0) / 60)}h` : '--'}</strong>
                </article>
                <article>
                  <span>Overtime</span>
                  <strong>{Number(selectedAttendanceRecord?.overtimeHours || 0) ? `${Math.round(Number(selectedAttendanceRecord.overtimeHours || 0) * 100) / 100}h` : '--'}</strong>
                </article>
                <article>
                  <span>OT Pay</span>
                  <strong>{Number(selectedAttendanceRecord?.overtimePay || 0).toLocaleString()}</strong>
                </article>
                <article>
                  <span>Season</span>
                  <strong>{selectedAttendanceRecord?.overtimeLabel || '--'}</strong>
                </article>
              </div>
              <p className="muted employee-calendar-note">
                Overtime is highlighted automatically for the Christmas and New Year season when checkout goes beyond the scheduled end time.
              </p>
            </div>
          </section>

          <section className="card employee-history-card">
            <div className="employee-section-head">
              <div>
                <p className="eyebrow">Last 7 Days</p>
                <h3>Attendance trail</h3>
              </div>
            </div>
            <div className="employee-history-list">
              {historyRows.length === 0 ? (
                <EmptyState
                  icon="📅"
                  title="No attendance records"
                  description="Your recent check-ins and check-outs will appear here."
                />
              ) : (
                historyRows.map((item) => (
                  <div key={item.key} className="employee-history-row">
                    <span className="employee-history-dot" />
                    <span>{item.label}</span>
                    <span>{item.timeline}</span>
                    <span className={`employee-history-pill ${item.status.toLowerCase().replace(' ', '-')}`}>
                      {item.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </main>
  )
}

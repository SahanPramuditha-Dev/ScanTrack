import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { APP_CONFIG } from '../config'
import { downloadCsv } from '../lib/csv'
import {
  clearAttendanceForDate,
  clearNotifications,
  createEmployeeByAdmin,
  formatAuthName,
  getAdminLogs,
  getAdminSettings,
  getEmployeeDirectory,
  getEmployees,
  getLateAlerts,
  getTokenHistory,
  isAdminUser,
  issueTvToken,
  saveAdminSettings,
  toLogExportRows,
} from '../services/attendanceService'

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'employees', label: 'Employees' },
  { key: 'qrcodes', label: 'QR Codes' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'settings', label: 'Settings' },
]

function exportExcel(filename, rows) {
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance')
  XLSX.writeFile(workbook, filename)
}

function buildQrUrl(token) {
  const url = `${window.location.origin}/employee?t=${token}`
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(url)}`
}

function formatClock(iso) {
  if (!iso) return '-'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AdminPage({ user }) {
  const [section, setSection] = useState('dashboard')
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [logs, setLogs] = useState([])
  const [employees, setEmployees] = useState([])
  const [directory, setDirectory] = useState([])
  const [alerts, setAlerts] = useState([])
  const [tokenHistory, setTokenHistory] = useState([])
  const [settings, setSettings] = useState({
    workStart: APP_CONFIG.workStart,
    workEnd: '18:00',
    graceMins: APP_CONFIG.gracePeriodMinutes,
    lateAlerts: true,
    gpsVerify: false,
    dupePrevention: true,
    employeeDarkMode: false,
    refreshInterval: APP_CONFIG.tokenRefreshSeconds,
  })

  const [selectedEmployee, setSelectedEmployee] = useState('all')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [newEmpName, setNewEmpName] = useState('')
  const [newEmpEmail, setNewEmpEmail] = useState('')
  const [newEmpRole, setNewEmpRole] = useState('employee')
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const loadData = useCallback(async () => {
    if (!user || !isAdminUser(user)) {
      return
    }

    setLoading(true)
    setError('')

    try {
      const [actionLogs, workers, employeeDirectory, tokenRows, rules, lateAlerts] = await Promise.all([
        getAdminLogs(),
        getEmployees(),
        getEmployeeDirectory(date),
        getTokenHistory(),
        getAdminSettings(),
        getLateAlerts(date),
      ])

      setLogs(actionLogs)
      setEmployees(workers)
      setDirectory(employeeDirectory)
      setTokenHistory(tokenRows)
      setSettings((old) => ({ ...old, ...rules }))
      setAlerts(lateAlerts)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [date, user])

  useEffect(() => {
    loadData()
  }, [loadData])

  const filteredLogs = useMemo(() => {
    const keyword = search.trim().toLowerCase()

    return logs.filter((log) => {
      const byDate = !date || log.date === date
      const byEmp = selectedEmployee === 'all' || log.userId === selectedEmployee
      const byType = typeFilter === 'all' || log.action === typeFilter
      const status = log.action === 'checkIn' ? (log.late ? 'late' : 'ontime') : 'none'
      const byStatus =
        statusFilter === 'all' ||
        (statusFilter === 'late' && status === 'late') ||
        (statusFilter === 'ontime' && status === 'ontime')
      const bySearch =
        !keyword ||
        (log.employeeName || '').toLowerCase().includes(keyword) ||
        (log.userId || '').toLowerCase().includes(keyword)

      return byDate && byEmp && byType && byStatus && bySearch
    })
  }, [logs, date, selectedEmployee, typeFilter, statusFilter, search])

  const dashboardSummary = useMemo(() => {
    const todayLogs = logs.filter((item) => item.date === date)
    const checkIns = todayLogs.filter((item) => item.action === 'checkIn')
    const late = checkIns.filter((item) => item.late)
    const checkedOut = todayLogs.filter((item) => item.action === 'checkOut')
    const uniqueStaff = new Set(todayLogs.map((item) => item.userId)).size

    return {
      totalRecords: logs.length,
      todayCheckIns: checkIns.length,
      lateArrivals: late.length,
      checkedOut: checkedOut.length,
      uniqueStaff,
      onTimePercent: checkIns.length ? Math.round(((checkIns.length - late.length) / checkIns.length) * 100) : 0,
      recent: todayLogs.slice(0, 8),
    }
  }, [logs, date])

  const logExportRows = useMemo(() => toLogExportRows(filteredLogs), [filteredLogs])
  const activeToken = tokenHistory.find((token) => token.active) || tokenHistory[0] || null

  const createEmployee = async (event) => {
    event.preventDefault()
    setSavingEmployee(true)
    setError('')
    setMessage('')
    try {
      await createEmployeeByAdmin({
        name: newEmpName,
        email: newEmpEmail,
        role: newEmpRole,
        createdBy: user.uid || user.id,
      })
      setNewEmpName('')
      setNewEmpEmail('')
      setNewEmpRole('employee')
      setMessage('Employee access created.')
      await loadData()
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingEmployee(false)
    }
  }

  const saveSettings = async () => {
    setSavingSettings(true)
    setError('')
    setMessage('')
    try {
      await saveAdminSettings(settings)
      setMessage('Settings saved.')
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingSettings(false)
    }
  }

  const regenerateToken = async () => {
    setError('')
    setMessage('')
    try {
      await issueTvToken(user, Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds))
      setMessage('New QR token generated.')
      await loadData()
    } catch (err) {
      setError(err.message)
    }
  }

  const clearAlerts = async () => {
    setError('')
    setMessage('')
    try {
      await clearNotifications()
      setMessage('Late alerts cleared.')
      await loadData()
    } catch (err) {
      setError(err.message)
    }
  }

  const clearToday = async () => {
    setError('')
    setMessage('')
    try {
      await clearAttendanceForDate(date)
      setMessage(`Attendance cleared for ${date}.`)
      await loadData()
    } catch (err) {
      setError(err.message)
    }
  }

  const copyToken = async () => {
    if (!activeToken?.token) return
    try {
      await navigator.clipboard.writeText(activeToken.token)
      setMessage('Token copied to clipboard.')
    } catch {
      setError('Clipboard copy not available in this browser.')
    }
  }

  const chartBars = useMemo(() => {
    const bars = []
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const dayLogs = logs.filter((item) => item.date === key && item.action === 'checkIn')
      const late = dayLogs.filter((item) => item.late).length
      bars.push({
        label: i === 0 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
        onTime: dayLogs.length - late,
        late,
      })
    }
    return bars
  }, [logs])

  if (!user || !isAdminUser(user)) {
    return (
      <main className="layout narrow admin-layout">
        <section className="card">
          <h2>Admin access required</h2>
          <p className="muted">Please sign in with an admin account.</p>
        </section>
      </main>
    )
  }

  return (
    <main className="layout admin-workspace">
      <aside className="card admin-sidebar">
        <p className="eyebrow">Overview</p>
        <h2>Admin</h2>
        <p className="muted">{formatAuthName(user)}</p>

        <nav className="admin-nav">
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`admin-nav-item ${section === item.key ? 'active' : ''}`}
              onClick={() => setSection(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="admin-main">
        {section === 'dashboard' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Dashboard Overview</p>
                <h1>Today - {date}</h1>
              </div>
              <div className="row gap wrap">
                <button className="ghost" onClick={() => exportExcel(`dashboard-${date}.xlsx`, logExportRows)}>Export Excel</button>
                <button className="ghost" onClick={() => downloadCsv(`dashboard-${date}.csv`, logExportRows)}>Export CSV</button>
              </div>
            </section>

            <section className="stats-grid six">
              <article className="card stat-card"><h3>{dashboardSummary.totalRecords}</h3><p>Total Records</p></article>
              <article className="card stat-card"><h3>{dashboardSummary.todayCheckIns}</h3><p>Today Check-Ins</p></article>
              <article className="card stat-card danger"><h3>{dashboardSummary.lateArrivals}</h3><p>Late Arrivals</p></article>
              <article className="card stat-card"><h3>{dashboardSummary.checkedOut}</h3><p>Checked Out</p></article>
              <article className="card stat-card"><h3>{dashboardSummary.uniqueStaff}</h3><p>Unique Staff</p></article>
              <article className="card stat-card"><h3>{dashboardSummary.onTimePercent}%</h3><p>On Time %</p></article>
            </section>

            <section className="card">
              <h3>Last 7 Days - Check-In Activity</h3>
              <div className="mini-chart">
                {chartBars.map((bar) => (
                  <div key={bar.label} className="mini-col">
                    <div className="mini-stack">
                      <div className="mini-seg late" style={{ height: `${Math.max(8, bar.late * 18)}px` }} />
                      <div className="mini-seg ontime" style={{ height: `${Math.max(8, bar.onTime * 18)}px` }} />
                    </div>
                    <span>{bar.label}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card">
              <h3>Recent Activity</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Name</th><th>ID</th><th>Type</th><th>Status</th><th>Time</th></tr>
                  </thead>
                  <tbody>
                    {dashboardSummary.recent.map((log) => (
                      <tr key={log.id}>
                        <td>{log.employeeName}</td>
                        <td><code>{log.userId}</code></td>
                        <td>{log.action === 'checkIn' ? 'Check In' : 'Check Out'}</td>
                        <td>{log.action === 'checkIn' ? <span className={`pill ${log.late ? 'danger' : 'ok'}`}>{log.late ? 'Late' : 'On Time'}</span> : '-'}</td>
                        <td>{formatClock(log.clientTs)}</td>
                      </tr>
                    ))}
                    {!dashboardSummary.recent.length && (
                      <tr><td colSpan={5} className="muted">No activity yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {section === 'attendance' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Attendance Log</p>
                <h1>Full records with filters</h1>
              </div>
              <div className="row gap wrap">
                <button className="ghost" onClick={() => exportExcel(`attendance-${date}.xlsx`, logExportRows)}>Excel</button>
                <button className="ghost" onClick={() => downloadCsv(`attendance-${date}.csv`, logExportRows)}>CSV</button>
                <button className="ghost" onClick={clearToday}>Clear All</button>
              </div>
            </section>

            <section className="card">
              <div className="grid filters wide">
                <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
                <label>Search<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / id" /></label>
                <label>Employee
                  <select value={selectedEmployee} onChange={(e) => setSelectedEmployee(e.target.value)}>
                    <option value="all">All employees</option>
                    {employees
                      .filter((employee) => employee.role !== 'admin')
                      .map((employee) => (
                        <option key={employee.id || employee.userId} value={employee.id || employee.userId}>
                          {employee.name || employee.email}
                        </option>
                      ))}
                  </select>
                </label>
                <label>Type
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="all">All types</option>
                    <option value="checkIn">Check In</option>
                    <option value="checkOut">Check Out</option>
                  </select>
                </label>
                <label>Status
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="all">All status</option>
                    <option value="ontime">On Time</option>
                    <option value="late">Late</option>
                  </select>
                </label>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>#</th><th>Name</th><th>ID</th><th>Type</th><th>Status</th><th>Date</th><th>Time</th><th>GPS</th></tr>
                  </thead>
                  <tbody>
                    {filteredLogs.map((log, index) => (
                      <tr key={log.id || `${log.userId}-${index}`}>
                        <td>{index + 1}</td>
                        <td>{log.employeeName}</td>
                        <td><code>{log.userId}</code></td>
                        <td><span className="pill neutral">{log.action === 'checkIn' ? 'Check In' : 'Check Out'}</span></td>
                        <td>{log.action === 'checkIn' ? <span className={`pill ${log.late ? 'danger' : 'ok'}`}>{log.late ? 'Late' : 'On Time'}</span> : '-'}</td>
                        <td>{log.date}</td>
                        <td>{formatClock(log.clientTs)}</td>
                        <td>{log.gps || '-'}</td>
                      </tr>
                    ))}
                    {!filteredLogs.length && <tr><td colSpan={8} className="muted">No records found.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {section === 'employees' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Employee Directory</p>
                <h1>Today&apos;s check-in status</h1>
              </div>
            </section>

            <section className="card">
              <form className="grid filters wide" onSubmit={createEmployee}>
                <label>Name<input value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} required /></label>
                <label>Email<input type="email" value={newEmpEmail} onChange={(e) => setNewEmpEmail(e.target.value)} required /></label>
                <label>Role
                  <select value={newEmpRole} onChange={(e) => setNewEmpRole(e.target.value)}>
                    <option value="employee">Employee</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <label>Action<button type="submit" disabled={savingEmployee}>{savingEmployee ? 'Saving...' : '+ Add Employee'}</button></label>
              </form>
            </section>

            <section className="employee-grid">
              {directory.map((item) => (
                <article key={item.uid} className="card emp-card">
                  <div className="emp-avatar">{(item.name || 'E').slice(0, 2).toUpperCase()}</div>
                  <h3>{item.name}</h3>
                  <p className="muted">{item.email}</p>
                  <p><span className={`pill ${item.late ? 'danger' : 'neutral'}`}>{item.status}</span></p>
                </article>
              ))}
              {!directory.length && <section className="card"><p className="muted">No employees found.</p></section>}
            </section>
          </>
        )}

        {section === 'qrcodes' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">QR Code Management</p>
                <h1>Active token controls</h1>
              </div>
              <button onClick={regenerateToken}>Regenerate Now</button>
            </section>

            <section className="grid two">
              <article className="card">
                <div className="row between"><h3>Current Token</h3><span className={`pill ${activeToken?.active ? 'ok' : 'neutral'}`}>{activeToken?.active ? 'Active' : 'Expired'}</span></div>
                {activeToken?.token ? (
                  <>
                    <img className="qr-image" src={buildQrUrl(activeToken.token)} alt="Current QR" />
                    <p className="token-inline">{activeToken.token}</p>
                    <p className="muted">Expires in {Math.max(0, Math.floor((activeToken.expiresAtMs - Date.now()) / 1000))}s</p>
                    <button className="ghost" onClick={copyToken}>Copy</button>
                  </>
                ) : (
                  <p className="muted">No token issued yet.</p>
                )}
              </article>

              <article className="card">
                <h3>Refresh Interval</h3>
                <div className="row gap wrap">
                  {[30, 60, 300, 3600, 86400].map((interval) => (
                    <button
                      key={interval}
                      type="button"
                      className={Number(settings.refreshInterval) === interval ? '' : 'ghost'}
                      onClick={() => setSettings((old) => ({ ...old, refreshInterval: interval }))}
                    >
                      {interval < 60 ? `${interval}s` : interval < 3600 ? `${interval / 60}m` : interval < 86400 ? `${interval / 3600}h` : 'Daily'}
                    </button>
                  ))}
                </div>

                <h3 style={{ marginTop: 16 }}>Token History</h3>
                <div className="token-history-list">
                  {tokenHistory.slice(0, 8).map((token) => (
                    <div key={token.token} className="row between token-row">
                      <code>{token.token}</code>
                      <span className={`pill ${token.active ? 'ok' : 'neutral'}`}>{token.active ? 'Active' : 'Expired'}</span>
                      <span className="muted">{token.scansCount || 0} uses</span>
                    </div>
                  ))}
                </div>
              </article>
            </section>

            <section className="card">
              <h3>Token Usage Log</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Token</th><th>Created</th><th>Used</th><th>Status</th></tr></thead>
                  <tbody>
                    {tokenHistory.map((token) => (
                      <tr key={`log-${token.token}`}>
                        <td><code>{token.token}</code></td>
                        <td>{token.issuedAtMs ? new Date(token.issuedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                        <td>{token.scansCount || 0} times</td>
                        <td><span className={`pill ${token.active ? 'ok' : 'neutral'}`}>{token.active ? 'Active' : 'Expired'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {section === 'alerts' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Late Alerts</p>
                <h1>Auto-generated notifications</h1>
              </div>
              <button className="ghost" onClick={clearAlerts}>Clear all</button>
            </section>

            <section className="alerts-list">
              {alerts.map((alert) => (
                <article className="card alert-row" key={alert.id}>
                  <div>
                    <h3>{alert.employeeName} arrived late</h3>
                    <p className="muted">Checked in at {formatClock(alert.clientTs)} (work starts {settings.workStart}, grace: {settings.graceMins} min)</p>
                  </div>
                </article>
              ))}
              {!alerts.length && <section className="card"><p className="muted">No late alerts for selected date.</p></section>}
            </section>
          </>
        )}

        {section === 'settings' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">System Settings</p>
                <h1>Work hours, grace period, rules</h1>
              </div>
            </section>

            <section className="grid two">
              <article className="card">
                <h3>Work Hours</h3>
                <div className="stack">
                  <label>Work Start Time<input type="time" value={settings.workStart} onChange={(e) => setSettings((old) => ({ ...old, workStart: e.target.value }))} /></label>
                  <label>Work End Time<input type="time" value={settings.workEnd} onChange={(e) => setSettings((old) => ({ ...old, workEnd: e.target.value }))} /></label>
                  <label>Grace Period (minutes)<input type="number" min="0" value={settings.graceMins} onChange={(e) => setSettings((old) => ({ ...old, graceMins: Number(e.target.value) }))} /></label>
                </div>
              </article>

              <article className="card">
                <h3>Notifications & Rules</h3>
                <div className="settings-toggles">
                  <label className="toggle-row"><span>Late Arrival Alerts</span><input type="checkbox" checked={settings.lateAlerts} onChange={(e) => setSettings((old) => ({ ...old, lateAlerts: e.target.checked }))} /></label>
                  <label className="toggle-row"><span>GPS Verification</span><input type="checkbox" checked={settings.gpsVerify} onChange={(e) => setSettings((old) => ({ ...old, gpsVerify: e.target.checked }))} /></label>
                  <label className="toggle-row"><span>Duplicate Prevention</span><input type="checkbox" checked={settings.dupePrevention} onChange={(e) => setSettings((old) => ({ ...old, dupePrevention: e.target.checked }))} /></label>
                  <label className="toggle-row"><span>Employee Dark Mode</span><input type="checkbox" checked={settings.employeeDarkMode} onChange={(e) => setSettings((old) => ({ ...old, employeeDarkMode: e.target.checked }))} /></label>
                </div>
              </article>
            </section>

            <section className="card">
              <button onClick={saveSettings} disabled={savingSettings}>{savingSettings ? 'Saving...' : 'Save Changes'}</button>
            </section>
          </>
        )}

        {message && <section className="card"><p className="success-text">{message}</p></section>}
        {error && <section className="card"><p className="error-text">{error}</p></section>}
        {loading && <section className="card"><p className="muted">Loading admin data...</p></section>}
      </section>
    </main>
  )
}

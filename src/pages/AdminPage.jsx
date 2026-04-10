import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { APP_CONFIG } from '../config'
import { downloadCsv } from '../lib/csv'
import { formatDateKey, getTodayKey } from '../lib/time'
import {
  aggregateDailyPayments,
  bulkDeleteExpiredTokens,
  clearAttendanceForDate,
  clearNotificationsForDate,
  clearNotifications,
  createDailyPayment,
  createEmployeeByAdmin,
  createTvDisplaySession,
  deleteDailyPayment,
  deleteToken,
  formatAuthName,
  generateSalaryForMonth,
  getAttendanceByDateRange,
  getTokenHistory,
  getTokenStats,
  getAttendanceDailyForRange,
  getAdminLogs,
  getAdminSettings,
  getDailyPaymentsForMonth,
  getEmployeeAttendanceForMonth,
  getEmployees,
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  getSalaryRecordsForMonth,
  getScheduleForDate,
  isAdminUser,
  issueTvToken,
  monthKeyFromDateKey,
  removeEmployeeByAdmin,
  revokeToken,
  saveAdminSettings,
  setShopGps,
  summarizeAttendance,
  toLogExportRows,
  updateDailyPayment,
  updateEmployeeByAdmin,
} from '../services/attendanceService'

const SECTIONS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'employees', label: 'Employees' },
  { key: 'roles', label: 'Roles' },
  { key: 'salary', label: 'Salary' },
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

function formatRelative(iso) {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return ''
  const deltaMs = ts - Date.now()
  const absMs = Math.abs(deltaMs)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const mins = Math.round(deltaMs / 60000)
  const hours = Math.round(deltaMs / 3600000)
  const days = Math.round(deltaMs / 86400000)
  if (absMs < 3600000) return rtf.format(mins, 'minute')
  if (absMs < 86400000) return rtf.format(hours, 'hour')
  return rtf.format(days, 'day')
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const mins = Math.round(ms / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m}m`
  if (!m) return `${h}h`
  return `${h}h ${m}m`
}

const ALERT_ACK_KEY = 'scantrack_alert_ack'
const QR_REFRESH_OPTIONS = [60, 300, 3600, 86400]

function readAlertAck() {
  try {
    const raw = localStorage.getItem(ALERT_ACK_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAlertAck(next) {
  localStorage.setItem(ALERT_ACK_KEY, JSON.stringify(next))
}

function buildMapsUrl(gps) {
  if (!gps?.lat || !gps?.lng) return ''
  return `https://www.google.com/maps?q=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function calcLateMinutes(alert, schedule) {
  if (!alert?.clientTs || !schedule?.workStart) return null
  const ts = new Date(alert.clientTs)
  if (Number.isNaN(ts.getTime())) return null
  const [h, m] = String(schedule.workStart).split(':').map((v) => Number(v))
  const grace = Number(schedule.graceMins || 0) || 0
  const cutoff = new Date(ts)
  cutoff.setHours(h || 0, (m || 0) + grace, 0, 0)
  const diffMs = ts.getTime() - cutoff.getTime()
  if (diffMs <= 0) return 0
  return Math.round(diffMs / 60000)
}

function shiftDateKey(dateKey, days) {
  const base = new Date(`${dateKey}T12:00:00.000Z`)
  base.setUTCDate(base.getUTCDate() + days)
  return formatDateKey(base)
}

export function AdminPage({ user }) {
  const PAGE_SIZE = 12
  const WEEK = [
    { key: 'mon', label: 'Mon' },
    { key: 'tue', label: 'Tue' },
    { key: 'wed', label: 'Wed' },
    { key: 'thu', label: 'Thu' },
    { key: 'fri', label: 'Fri' },
    { key: 'sat', label: 'Sat' },
    { key: 'sun', label: 'Sun' },
  ]
  const [section, setSection] = useState('dashboard')
  const [loading, setLoading] = useState(true)
  const [date, setDate] = useState(getTodayKey())
  const [dateTouched, setDateTouched] = useState(false)
  const [dashboardRange, setDashboardRange] = useState('week')
  const [attendanceQuickFilter, setAttendanceQuickFilter] = useState('all')
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
    shopGps: APP_CONFIG.shopGps,
    verificationRadiusMeters: APP_CONFIG.verificationRadiusMeters,
    dupePrevention: true,
    employeeDarkMode: false,
    refreshInterval: APP_CONFIG.tokenRefreshSeconds,
    weeklySchedule: {
      mon: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
      tue: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
      wed: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
      thu: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
      fri: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
      sat: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
      sun: { enabled: true, workStart: APP_CONFIG.workStart, workEnd: '18:00', graceMins: APP_CONFIG.gracePeriodMinutes, allowCheckIn: true, allowCheckOut: true },
    },
    payrollRules: {
      expectedWorkDays: 26,
      defaultAllowedHolidays: 1,
      latePenaltyFraction: 0.5,
      perfectAttendanceBonus: 0,
      noLateBonus: 0,
    },
  })
  const [gpsLat, setGpsLat] = useState(APP_CONFIG.shopGps.lat)
  const [gpsLng, setGpsLng] = useState(APP_CONFIG.shopGps.lng)
  const [gpsRadius, setGpsRadius] = useState(APP_CONFIG.verificationRadiusMeters)
  const [savingGps, setSavingGps] = useState(false)
  const [locatingGps, setLocatingGps] = useState(false)
  const [uiTick, setUiTick] = useState(0)

  const [selectedEmployee, setSelectedEmployee] = useState('all')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [attendancePage, setAttendancePage] = useState(1)
  const [attendanceView, setAttendanceView] = useState('logs')
  const [showGpsColumn, setShowGpsColumn] = useState(true)
  const [employeeSearch, setEmployeeSearch] = useState('')
  const [employeeSort, setEmployeeSort] = useState('status')
  const [employeeStatusFilter, setEmployeeStatusFilter] = useState('all')
  const [employeeRoleFilter, setEmployeeRoleFilter] = useState('all')
  const [showInactiveEmployees, setShowInactiveEmployees] = useState(false)
  const [alertsSearch, setAlertsSearch] = useState('')
  const [alertsHideAcknowledged, setAlertsHideAcknowledged] = useState(true)
  const [alertsGroupByEmployee, setAlertsGroupByEmployee] = useState(true)
  const [alertAck, setAlertAck] = useState(() => readAlertAck())
  const [salaryMonth, setSalaryMonth] = useState(getTodayKey().slice(0, 7))
  const [salaryRows, setSalaryRows] = useState([])
  const [salarySearch, setSalarySearch] = useState('')
  const [salaryLoading, setSalaryLoading] = useState(false)
  const [salaryGenerating, setSalaryGenerating] = useState(false)
  const [salaryView, setSalaryView] = useState('monthly') // 'monthly' or 'daily'
  const [dailySalaryDate, setDailySalaryDate] = useState(getTodayKey())
  const [dailyPayments, setDailyPayments] = useState([])
  const [dailySalarySearch, setDailySalarySearch] = useState('')
  const [showDailyModal, setShowDailyModal] = useState(false)
  const [dailyModalEmployee, setDailyModalEmployee] = useState(null)
  const [dailyModalData, setDailyModalData] = useState({ dailySalary: '', deductions: { advance: 0, fine: 0, loan: 0, other: 0 }, notes: '' })
  const [savingDaily, setSavingDaily] = useState(false)
  const [salarySelectedUserId, setSalarySelectedUserId] = useState('')
  const [salarySelectedAttendanceRows, setSalarySelectedAttendanceRows] = useState([])
  const [salarySelectedDateKey, setSalarySelectedDateKey] = useState('')
  const [salaryDetailLoading, setSalaryDetailLoading] = useState(false)
  const [employeeDetail, setEmployeeDetail] = useState(null)
  const [employeeDetailMonth, setEmployeeDetailMonth] = useState(getTodayKey().slice(0, 7))
  const [employeeDetailDateKey, setEmployeeDetailDateKey] = useState('')
  const [employeeDetailRows, setEmployeeDetailRows] = useState([])
  const [employeeDetailLoading, setEmployeeDetailLoading] = useState(false)
  const [newEmpName, setNewEmpName] = useState('')
  const [newEmpEmail, setNewEmpEmail] = useState('')
  const [newEmpRole, setNewEmpRole] = useState('employee')
  const [newEmpRoleName, setNewEmpRoleName] = useState('')
  const [newEmpDailyRate, setNewEmpDailyRate] = useState('')
  const [roles, setRoles] = useState([])
  const [newRoleName, setNewRoleName] = useState('')
  const [newRolePayType, setNewRolePayType] = useState('DAILY')
  const [newRoleRate, setNewRoleRate] = useState('')
  const [editingRoleId, setEditingRoleId] = useState('')
  const [savingRole, setSavingRole] = useState(false)

  // Missing state variables
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [savingEmployee, setSavingEmployee] = useState(false)
  const [editingEmployeeId, setEditingEmployeeId] = useState('')
  const [newEmpAllowedHolidays, setNewEmpAllowedHolidays] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)

  // QR codes page state
  const [tokenSearch, setTokenSearch] = useState('')
  const [tokenStatusFilter, setTokenStatusFilter] = useState('all')
  const [tokenStats, setTokenStats] = useState(null)
  const [tokenStatsLoading, setTokenStatsLoading] = useState(false)
  const [attendanceRangeStart, setAttendanceRangeStart] = useState(getTodayKey())
  const [attendanceRangeEnd, setAttendanceRangeEnd] = useState(getTodayKey())
  const [attendanceRangeData, setAttendanceRangeData] = useState([])
  const [attendanceRangeLoading, setAttendanceRangeLoading] = useState(false)

  const loadData = useCallback(async () => {
    if (!user || !isAdminUser(user)) return
    setLoading(true)
    setError('')
    try {
      const [
        logsData,
        employeesData,
        settingsData,
        tokenHistoryData,
      ] = await Promise.all([
        getAdminLogs(date),
        getEmployees({ includeInactive: true }),
        getAdminSettings(),
        getTokenHistory(),
      ])
      setLogs(logsData)
      setEmployees(employeesData)
      setDirectory(employeesData) // directory is same as employees
      setAlerts([]) // TODO: implement alerts loading
      setTokenHistory(tokenHistoryData)
      if (settingsData) {
        setSettings({
          ...settingsData,
          refreshInterval: Math.max(60, Number(settingsData.refreshInterval || APP_CONFIG.tokenRefreshSeconds)),
        })
        setGpsLat(settingsData.shopGps?.lat || APP_CONFIG.shopGps.lat)
        setGpsLng(settingsData.shopGps?.lng || APP_CONFIG.shopGps.lng)
        setGpsRadius(settingsData.verificationRadiusMeters || APP_CONFIG.verificationRadiusMeters)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [user, date])

  useEffect(() => {
    if (!message) return undefined
    const timer = setTimeout(() => setMessage(''), 4200)
    return () => clearTimeout(timer)
  }, [message])

  useEffect(() => {
    if (!error) return undefined
    const timer = setTimeout(() => setError(''), 6500)
    return () => clearTimeout(timer)
  }, [error])

  useEffect(() => {
    const timer = setInterval(() => setUiTick((tick) => tick + 1), 30000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    setAlertAck(readAlertAck())
  }, [section, date])

  const loadRoles = useCallback(async () => {
    if (!user || !isAdminUser(user)) return
    try {
      const rolesData = await getRoles()
      setRoles(rolesData)
    } catch (err) {
      setError(err.message)
    }
  }, [user])

  const [dashboardRangeRows, setDashboardRangeRows] = useState([])
  const [dashboardRangeLoading, setDashboardRangeLoading] = useState(false)

  useEffect(() => {
    if (!user || !isAdminUser(user)) return
    let cancelled = false
    const loadDashboardRange = async () => {
      setDashboardRangeLoading(true)
      try {
        const end = date
        const start = dashboardRange === 'month' ? shiftDateKey(date, -29) : shiftDateKey(date, -6)
        const rows = await getAttendanceDailyForRange(start, end)
        if (!cancelled) {
          setDashboardRangeRows(rows)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setDashboardRangeLoading(false)
      }
    }
    loadDashboardRange()
    return () => {
      cancelled = true
    }
  }, [dashboardRange, date, user])

  useEffect(() => {
    loadData()
  }, [loadData])

  const loadSalary = useCallback(async () => {
    if (!user || !isAdminUser(user)) return
    setSalaryLoading(true)
    try {
      const rows = await getSalaryRecordsForMonth(salaryMonth)
      setSalaryRows(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setSalaryLoading(false)
    }
  }, [salaryMonth, user])

  const loadDailyPayments = useCallback(async () => {
    if (!user || !isAdminUser(user)) return
    try {
      const payments = await getDailyPaymentsForMonth(monthKeyFromDateKey(dailySalaryDate))
      setDailyPayments(payments)
    } catch (err) {
      setError(err.message)
    }
  }, [dailySalaryDate, user])

  useEffect(() => {
    if (salaryView !== 'daily') return
    loadDailyPayments()
  }, [loadDailyPayments, salaryView])

  useEffect(() => {
    if (section !== 'salary') return
    if (salaryView === 'monthly') loadSalary()
  }, [loadSalary, section, salaryView])

  useEffect(() => {
    if (section !== 'salary' || salaryView !== 'monthly' || !salarySelectedUserId) {
      setSalarySelectedAttendanceRows([])
      setSalaryDetailLoading(false)
      return undefined
    }

    let cancelled = false
    const loadAttendance = async () => {
      setSalaryDetailLoading(true)
      try {
        const rows = await getEmployeeAttendanceForMonth(salarySelectedUserId, salaryMonth)
        if (!cancelled) {
          setSalarySelectedAttendanceRows(rows)
          setSalarySelectedDateKey((current) => {
            if (current && rows.some((row) => row.date === current)) return current
            return rows[0]?.date || `${salaryMonth}-01`
          })
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
        }
      } finally {
        if (!cancelled) {
          setSalaryDetailLoading(false)
        }
      }
    }

    loadAttendance()
    return () => {
      cancelled = true
    }
  }, [salaryMonth, salarySelectedUserId, salaryView, section])

  useEffect(() => {
    if (section !== 'roles' && section !== 'employees') return
    loadRoles()
  }, [loadRoles, section])

  useEffect(() => {
    let cancelled = false
    const loadEmployeeDetail = async () => {
      setEmployeeDetailLoading(true)
      try {
        const rows = await getEmployeeAttendanceForMonth(employeeDetail.uid, employeeDetailMonth)
        if (!cancelled) {
          setEmployeeDetailRows(rows)
          setEmployeeDetailDateKey((current) => {
            if (current && rows.some((row) => row.date === current)) return current
            return rows[0]?.date || `${employeeDetailMonth}-01`
          })
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
        }
      } finally {
        if (!cancelled) {
          setEmployeeDetailLoading(false)
        }
      }
    }

    loadEmployeeDetail()
    return () => {
      cancelled = true
    }
  }, [employeeDetail?.uid, employeeDetailMonth])

  useEffect(() => {
    if (!logs.length || dateTouched) return
    const hasRowsForDate = logs.some((log) => log.date === date)
    if (hasRowsForDate) return
    const latestLogDate = logs
      .map((log) => log.date)
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a))[0]
    if (latestLogDate) {
      setDate(latestLogDate)
    }
  }, [logs, date, dateTouched])

  // Load token stats when QR codes section is active
  useEffect(() => {
    if (section !== 'qrcodes') return

    let cancelled = false
    const loadTokenStats = async () => {
      setTokenStatsLoading(true)
      try {
        const start = new Date()
        start.setDate(start.getDate() - 7)
        const end = new Date()
        const stats = await getTokenStats(start.toISOString(), end.toISOString())
        if (!cancelled) {
          setTokenStats(stats)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
        }
      } finally {
        if (!cancelled) {
          setTokenStatsLoading(false)
        }
      }
    }

    loadTokenStats()
    return () => {
      cancelled = true
    }
  }, [section])

  // Load attendance range data for export
  useEffect(() => {
    if (section !== 'qrcodes') return

    let cancelled = false
    const loadRangeData = async () => {
      setAttendanceRangeLoading(true)
      try {
        const data = await getAttendanceByDateRange(attendanceRangeStart, attendanceRangeEnd)
        if (!cancelled) {
          setAttendanceRangeData(data)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
        }
      } finally {
        if (!cancelled) {
          setAttendanceRangeLoading(false)
        }
      }
    }

    loadRangeData()
    return () => {
      cancelled = true
    }
  }, [section, attendanceRangeStart, attendanceRangeEnd])

  // Token filtering and validation
  const filteredTokens = useMemo(() => {
    const keyword = tokenSearch.trim().toLowerCase()
    return tokenHistory
      .filter((t) => tokenStatusFilter === 'all' || 
        (tokenStatusFilter === 'active' && t.active) ||
        (tokenStatusFilter === 'expired' && !t.active))
      .filter((t) => {
        if (!keyword) return true
        return String(t.token || '').includes(keyword) ||
          String(t.scansCount || 0).includes(keyword) ||
          String(t.issuedAt || '').includes(keyword)
      })
  }, [tokenHistory, tokenSearch, tokenStatusFilter])

  // Token validation alerts
  const tokenValidations = useMemo(() => {
    const warnings = []
    const today = new Date()
    const daysSinceLastRotation = Math.floor((today - new Date(tokenHistory[0]?.issuedAt || today)) / (1000 * 60 * 60 * 24))
    
    if (daysSinceLastRotation > 30) {
      warnings.push({
        type: 'rotation',
        severity: 'warning',
        message: `Token hasn't been rotated in ${daysSinceLastRotation} days. Consider rotating for security.`,
      })
    }

    const activeTokens = tokenHistory.filter((t) => t.active)
    if (activeTokens.length > 1) {
      warnings.push({
        type: 'multi-active',
        severity: 'danger',
        message: `${activeTokens.length} tokens are active. Only 1 should be active at a time.`,
      })
    }

    const lowScanTokens = tokenHistory
      .filter((t) => t.active && (t.scansCount || 0) < 2)
      .slice(0, 3)
    if (lowScanTokens.length > 0) {
      warnings.push({
        type: 'low-scans',
        severity: 'info',
        message: `${lowScanTokens.length} active token(s) have very few scans. Check if display is connected.`,
      })
    }

    return warnings
  }, [tokenHistory])

  const filteredLogs = useMemo(() => {
    const keyword = search.trim().toLowerCase()

    const rows = logs.filter((log) => {
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
    return rows.sort((a, b) => String(b.clientTs || '').localeCompare(String(a.clientTs || '')))
  }, [logs, date, selectedEmployee, typeFilter, statusFilter, search])

  const attendancePages = Math.max(1, Math.ceil(filteredLogs.length / PAGE_SIZE))
  const paginatedLogs = useMemo(
    () => filteredLogs.slice((attendancePage - 1) * PAGE_SIZE, attendancePage * PAGE_SIZE),
    [filteredLogs, attendancePage, PAGE_SIZE],
  )

  useEffect(() => {
    setAttendancePage(1)
  }, [date, search, selectedEmployee, typeFilter, statusFilter])

  useEffect(() => {
    if (attendancePage > attendancePages) {
      setAttendancePage(attendancePages)
    }
  }, [attendancePage, attendancePages])

  const attendanceSummary = useMemo(() => {
    const dateLogs = logs.filter((item) => item.date === date)
    const checkIns = dateLogs.filter((item) => item.action === 'checkIn')
    const late = checkIns.filter((item) => item.late)
    const checkOuts = dateLogs.filter((item) => item.action === 'checkOut')
    const uniqueStaff = new Set(dateLogs.map((item) => item.userId)).size

    return {
      dateTotal: dateLogs.length,
      dateCheckIns: checkIns.length,
      dateCheckOuts: checkOuts.length,
      dateLate: late.length,
      dateUniqueStaff: uniqueStaff,
      dateOnTimePercent: checkIns.length ? Math.round(((checkIns.length - late.length) / checkIns.length) * 100) : 0,
      filteredTotal: filteredLogs.length,
      filtersActive:
        (search.trim() ? 1 : 0) +
        (selectedEmployee !== 'all' ? 1 : 0) +
        (typeFilter !== 'all' ? 1 : 0) +
        (statusFilter !== 'all' ? 1 : 0),
    }
  }, [date, filteredLogs.length, logs, search, selectedEmployee, statusFilter, typeFilter])

  const scheduleForSelectedDate = useMemo(() => getScheduleForDate(date, settings), [date, settings])

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
  const employeeLookupById = useMemo(() => {
    const map = new Map()
    for (const employee of employees) {
      const key = employee.id || employee.uid || employee.userId
      if (!key) continue
      map.set(String(key), employee)
    }
    for (const entry of directory) {
      const key = entry.uid || entry.id || entry.userId
      if (!key) continue
      if (!map.has(String(key))) {
        map.set(String(key), entry)
      }
    }
    return map
  }, [directory, employees])
  const directoryRows = useMemo(() => {
    const keyword = employeeSearch.trim().toLowerCase()
    const rows = directory
      .filter((entry) => (showInactiveEmployees ? true : entry.active !== false))
      .filter((entry) => employeeRoleFilter === 'all' || String(entry.role || 'employee') === employeeRoleFilter)
      .filter((entry) => {
        const status = String(entry.status || '').toLowerCase()
        const isCheckedIn = Boolean(entry.checkInAt)
        const isLate = Boolean(entry.late)
        const isCheckedOut = Boolean(entry.checkOutAt)
        return (
          employeeStatusFilter === 'all' ||
          (employeeStatusFilter === 'checkedIn' && isCheckedIn) ||
          (employeeStatusFilter === 'late' && isLate) ||
          (employeeStatusFilter === 'checkedOut' && isCheckedOut) ||
          (employeeStatusFilter === 'inactive' && entry.active === false) ||
          status.includes(employeeStatusFilter)
        )
      })
      .filter((entry) => {
        if (!keyword) return true
        const name = String(entry.name || '').toLowerCase()
        const email = String(entry.email || '').toLowerCase()
        const uid = String(entry.uid || entry.id || '').toLowerCase()
        const role = String(entry.role || '').toLowerCase()
        return name.includes(keyword) || email.includes(keyword) || uid.includes(keyword) || role.includes(keyword)
      })

    const sorted = [...rows].sort((a, b) => {
      if (employeeSort === 'name') {
        return String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''))
      }
      if (employeeSort === 'email') {
        return String(a.email || '').localeCompare(String(b.email || ''))
      }
      if (employeeSort === 'late') {
        return Number(Boolean(b.late)) - Number(Boolean(a.late)) || String(a.name || '').localeCompare(String(b.name || ''))
      }
      if (employeeSort === 'recent') {
        return String(b.checkInAt || b.updatedAt || '').localeCompare(String(a.checkInAt || a.updatedAt || ''))
      }
      const aScore = Number(Boolean(a.late)) * 3 + Number(Boolean(a.checkInAt)) * 2 + Number(Boolean(a.checkOutAt)) * 1
      const bScore = Number(Boolean(b.late)) * 3 + Number(Boolean(b.checkInAt)) * 2 + Number(Boolean(b.checkOutAt)) * 1
      return bScore - aScore || String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''))
    })

    return sorted
  }, [directory, employeeRoleFilter, employeeSearch, employeeSort, employeeStatusFilter, showInactiveEmployees])

  const directorySummary = useMemo(() => summarizeAttendance(directory), [directory])

  const filteredSalaryRows = useMemo(() => {
    const keyword = salarySearch.trim().toLowerCase()
    if (!keyword) return salaryRows
    return salaryRows.filter((row) => {
      const name = String(row.employeeName || '').toLowerCase()
      const email = String(row.email || '').toLowerCase()
      const uid = String(row.userId || '').toLowerCase()
      return name.includes(keyword) || email.includes(keyword) || uid.includes(keyword)
    })
  }, [salaryRows, salarySearch])

  const filteredDailyPayments = useMemo(() => {
    const keyword = dailySalarySearch.trim().toLowerCase()
    if (!keyword) return dailyPayments
    return dailyPayments.filter((row) => {
      const name = String(row.employeeName || '').toLowerCase()
      const uid = String(row.userId || '').toLowerCase()
      return name.includes(keyword) || uid.includes(keyword)
    }).sort((a, b) => String(b.date).localeCompare(String(a.date)))
  }, [dailyPayments, dailySalarySearch])

  const salaryStats = useMemo(() => {
    const totalPayroll = filteredSalaryRows.reduce((sum, row) => sum + Number(row.finalSalary || 0), 0)
    const totalDeductions = filteredSalaryRows.reduce((sum, row) => sum + Number(row.deductions || 0), 0)
    const totalBonus = filteredSalaryRows.reduce((sum, row) => sum + Number(row.bonus || 0), 0)
    const avg = filteredSalaryRows.length ? Math.round((totalPayroll / filteredSalaryRows.length) * 100) / 100 : 0
    return {
      count: filteredSalaryRows.length,
      totalPayroll: Math.round(totalPayroll * 100) / 100,
      totalDeductions: Math.round(totalDeductions * 100) / 100,
      totalBonus: Math.round(totalBonus * 100) / 100,
      avg,
    }
  }, [filteredSalaryRows])

  const filteredAlerts = useMemo(() => {
    const keyword = alertsSearch.trim().toLowerCase()
    return alerts
      .map((item) => ({ ...item, _key: item?.id || `${item.userId || 'u'}_${item.clientTs || item.date || ''}` }))
      .filter((item) => (alertsHideAcknowledged ? !alertAck[item._key] : true))
      .filter((item) => {
        if (!keyword) return true
        const name = String(item.employeeName || '').toLowerCase()
        const uid = String(item.userId || '').toLowerCase()
        const token = String(item.token || '').toLowerCase()
        return name.includes(keyword) || uid.includes(keyword) || token.includes(keyword)
      })
      .sort((a, b) => String(b.clientTs || '').localeCompare(String(a.clientTs || '')))
  }, [alertAck, alerts, alertsHideAcknowledged, alertsSearch])

  const alertsStats = useMemo(() => {
    const schedule = getScheduleForDate(date, settings)
    const unique = new Set(filteredAlerts.map((a) => a.userId).filter(Boolean)).size
    const mins = filteredAlerts
      .map((a) => calcLateMinutes(a, schedule))
      .filter((x) => x != null)
    const avg = mins.length ? Math.round(mins.reduce((s, v) => s + v, 0) / mins.length) : 0
    const worst = mins.length ? Math.max(...mins) : 0
    const onDateTotal = alerts.length
    return {
      total: filteredAlerts.length,
      onDateTotal,
      unique,
      avgLateMins: avg,
      worstLateMins: worst,
      schedule,
    }
  }, [alerts.length, date, filteredAlerts, settings])

  const groupedAlerts = useMemo(() => {
    if (!alertsGroupByEmployee) return []
    const groups = new Map()
    for (const item of filteredAlerts) {
      const uid = item.userId || 'unknown'
      if (!groups.has(uid)) groups.set(uid, [])
      groups.get(uid).push(item)
    }
    return Array.from(groups.entries())
      .map(([uid, items]) => ({
        uid,
        employeeName: items[0]?.employeeName || uid,
        items,
        latestTs: items[0]?.clientTs || '',
      }))
      .sort((a, b) => String(b.latestTs || '').localeCompare(String(a.latestTs || '')))
  }, [alertsGroupByEmployee, filteredAlerts])

  const createEmployee = async (event) => {
    event.preventDefault()
    setSavingEmployee(true)
    setError('')
    setMessage('')
    try {
      if (editingEmployeeId) {
        await updateEmployeeByAdmin({
          id: editingEmployeeId,
          name: newEmpName,
          email: newEmpEmail,
          role: newEmpRole,
          roleName: newEmpRoleName,
          dailyRate: Number(newEmpDailyRate || 0),
          allowedHolidays: Number(newEmpAllowedHolidays || 0),
          updatedBy: user.uid || user.id,
        })
      } else {
await createEmployeeByAdmin({
          name: newEmpName,
          email: newEmpEmail.trim().toLowerCase(),
          role: newEmpRole,
          roleName: newEmpRoleName,
          dailyRate: Number(newEmpDailyRate || 0),
          allowedHolidays: Number(newEmpAllowedHolidays || 0),
          createdBy: user.uid || user.id,
        })
      }
      setNewEmpName('')
      setNewEmpEmail('')
      setNewEmpRole('employee')
      setNewEmpRoleName('')
      setNewEmpDailyRate('')
      setNewEmpAllowedHolidays('')
      setEditingEmployeeId('')
      setMessage(editingEmployeeId ? 'Employee updated.' : 'Employee access created.')
      await loadData()
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingEmployee(false)
    }
  }

  const startEditEmployee = (employee) => {
    setEditingEmployeeId(employee.uid || employee.id || '')
    setNewEmpName(employee.name || '')
    setNewEmpEmail(employee.email || '')
    setNewEmpRole(employee.role || 'employee')
    setNewEmpRoleName(employee.roleName || '')
    setNewEmpDailyRate(String(employee.dailyRate ?? ''))
    setNewEmpAllowedHolidays(String(employee.allowedHolidays ?? ''))
  }

  const cancelEditEmployee = () => {
    setEditingEmployeeId('')
    setNewEmpName('')
    setNewEmpEmail('')
    setNewEmpRole('employee')
    setNewEmpRoleName('')
    setNewEmpDailyRate('')
    setNewEmpAllowedHolidays('')
  }

  const removeEmployee = async (employee) => {
    const id = employee.uid || employee.id
    if (!id) return
    const ok = window.confirm(`Remove ${employee.name || employee.email || 'employee'} from active staff?`)
    if (!ok) return

    setError('')
    setMessage('')
    try {
      await removeEmployeeByAdmin(id, user.uid || user.id)
      if (editingEmployeeId === id) {
        cancelEditEmployee()
      }
      setMessage('Employee removed from active directory.')
      await loadData()
    } catch (err) {
      setError(err.message)
    }
  }

  const resetAttendanceFilters = () => {
    setSearch('')
    setSelectedEmployee('all')
    setTypeFilter('all')
    setStatusFilter('all')
    setAttendancePage(1)
  }

  const saveSettings = async () => {
    setSavingSettings(true)
    setError('')
    setMessage('')
    try {
      if (!settings.workStart || !settings.workEnd) {
        throw new Error('Work start and end time are required.')
      }
      if (Number(settings.graceMins) < 0) {
        throw new Error('Grace period cannot be negative.')
      }
      if (Number(settings.refreshInterval) < 60) {
        throw new Error('QR refresh interval must be at least 60 seconds.')
      }
      if (settings.payrollRules) {
        if (Number(settings.payrollRules.expectedWorkDays) <= 0) {
          throw new Error('Payroll: expected work days must be greater than 0.')
        }
        if (Number(settings.payrollRules.defaultAllowedHolidays) < 0) {
          throw new Error('Payroll: default allowed holidays cannot be negative.')
        }
        if (Number(settings.payrollRules.latePenaltyFraction) < 0) {
          throw new Error('Payroll: late penalty fraction cannot be negative.')
        }
        if (Number(settings.payrollRules.overtimeThresholdMins) < 0) {
          throw new Error('Payroll: overtime threshold cannot be negative.')
        }
        if (Number(settings.payrollRules.overtimeMultiplier) < 1) {
          throw new Error('Payroll: overtime multiplier must be at least 1.')
        }
        if (Number(settings.payrollRules.seasonalOvertimeMultiplier) < 1) {
          throw new Error('Payroll: seasonal overtime multiplier must be at least 1.')
        }
      }
      if (settings.weeklySchedule && typeof settings.weeklySchedule === 'object') {
        for (const { key } of WEEK) {
          const rule = settings.weeklySchedule[key]
          if (!rule) continue
          if (rule.enabled === false) continue
          if (!rule.workStart || !rule.workEnd) {
            throw new Error('Weekly schedule: work start and end time are required for enabled days.')
          }
          if (Number(rule.graceMins) < 0) {
            throw new Error('Weekly schedule: grace minutes cannot be negative.')
          }
        }
      }
      await saveAdminSettings(settings)
      setMessage('Settings saved.')
      await loadData()
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
      // Refresh token history immediately
      const freshHistory = await getTokenHistory()
      setTokenHistory(freshHistory)
    } catch (err) {
      setError(err.message)
    }
  }

  const launchTvDisplay = async () => {
    setError('')
    setMessage('')
    try {
      const session = await createTvDisplaySession(
        user,
        Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds),
      )
      try {
        await navigator.clipboard.writeText(session.launchUrl)
        setMessage('TV display link copied. The owner can bookmark this same link and open it daily without admin login.')
      } catch {
        window.prompt('Copy this TV display link:', session.launchUrl)
        setMessage('TV display link generated. Bookmark this same link on the shop device for one-click opening.')
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const clearAlerts = async () => {
    setError('')
    setMessage('')
    try {
      await clearNotificationsForDate(date)
      setMessage(`Late alerts cleared for ${date}.`)
      await loadData()
    } catch (err) {
      setError(err.message)
    }
  }

  const clearAllAlerts = async () => {
    const ok = window.confirm('Clear ALL late alerts? This will delete late-alert log entries across all dates.')
    if (!ok) return
    setError('')
    setMessage('')
    try {
      await clearNotifications()
      setMessage('All late alerts cleared.')
      await loadData()
    } catch (err) {
      setError(err.message)
    }
  }

  const acknowledgeAlert = (alertKey) => {
    const next = { ...(readAlertAck() || {}), [alertKey]: new Date().toISOString() }
    writeAlertAck(next)
    setAlertAck(next)
    setMessage('Alert acknowledged.')
  }

  const unacknowledgeAlert = (alertKey) => {
    const next = { ...(readAlertAck() || {}) }
    delete next[alertKey]
    writeAlertAck(next)
    setAlertAck(next)
    setMessage('Acknowledgement removed.')
  }

  const generateSalary = async () => {
    if (!salaryMonth) return
    const ok = window.confirm(`Generate salary records for ${salaryMonth}? This will overwrite existing records for that month.`)
    if (!ok) return
    setSalaryGenerating(true)
    setError('')
    setMessage('')
    try {
      await generateSalaryForMonth({ monthKey: salaryMonth, generatedBy: user.uid || user.id })
      setMessage(`Salary generated for ${salaryMonth}.`)
      await loadSalary()
    } catch (err) {
      const message = String(err?.message || '')
      if (/missing or insufficient permissions/i.test(message)) {
        setError(
          `Missing permissions for payroll write. Ensure role=admin exists on employees/${user.uid || user.id} in Firestore, then sign out and sign in again.`,
        )
      } else {
        setError(message || 'Failed to generate salary records.')
      }
    } finally {
      setSalaryGenerating(false)
    }
  }

  const exportSalaryCsv = () => {
    const rows = filteredSalaryRows.map((r) => ({
      Month: r.month,
      Employee: r.employeeName,
      Email: r.email || '-',
      UID: r.userId,
      'Daily Rate': r.dailyRate,
      'Expected Days': r.expectedWorkDays,
      Present: r.daysPresent,
      Absent: r.daysAbsent,
      'Paid Leave': r.paidLeave,
      'Unpaid Leave': r.unpaidLeave,
      Late: r.lateDays,
      'Manual Days': r.manualCount,
      'Overtime Hours': r.overtimeHours,
      'Overtime Pay': r.overtimePay,
      'Attendance Base': r.attendanceBase,
      'Manual Salary': r.manualSalary,
      'Manual Deductions': r.manualDeductions,
      Deductions: r.deductions,
      Bonus: r.bonus,
      'Final Salary': r.finalSalary,
    }))
    downloadCsv(`salary-${salaryMonth}.csv`, rows)
  }

  const exportDailyCsv = () => {
    const rows = filteredDailyPayments.map((r) => ({
      Date: r.date,
      Employee: r.employeeName,
      UID: r.userId,
      'Daily Salary': r.dailySalary,
      Advance: r.deductions?.advance || 0,
      Fine: r.deductions?.fine || 0,
      Loan: r.deductions?.loan || 0,
      Other: r.deductions?.other || 0,
      'Total Deductions': r.totalDeductions,
      'Net Pay': r.netPay,
      Notes: r.notes,
    }))
    downloadCsv(`daily-payments-${dailySalaryDate.slice(0,7)}.csv`, rows)
  }

  const openDailyPaymentModal = (row = null) => {
    const employee = row
      ? { id: row.userId, name: row.employeeName, docId: row.id, date: row.date }
      : employees.find((emp) => (emp.role || 'employee') !== 'admin' && emp.active !== false) || null

    setDailySalaryDate(row?.date || dailySalaryDate)
    setDailyModalEmployee(employee)
    setDailyModalData({
      dailySalary: row?.dailySalary ?? '',
      deductions: row?.deductions || { advance: 0, fine: 0, loan: 0, other: 0 },
      notes: row?.notes || '',
    })
    setShowDailyModal(true)
  }

  const clearToday = async () => {
    const ok = window.confirm(`Clear attendance for ${date}? This will delete daily records and logs for the selected date.`)
    if (!ok) return
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

  const handleRevokeToken = async (tokenId) => {
    if (!window.confirm('Revoke this token? It will become inactive immediately.')) return
    setError('')
    setMessage('')
    try {
      await revokeToken(tokenId)
      setMessage('Token revoked.')
      const freshHistory = await getTokenHistory()
      setTokenHistory(freshHistory)
    } catch (err) {
      setError(err.message)
    }
  }

  const handleDeleteToken = async (tokenId) => {
    if (!window.confirm('Delete this token permanently? This action cannot be undone.')) return
    setError('')
    setMessage('')
    try {
      await deleteToken(tokenId)
      setMessage('Token deleted.')
      const freshHistory = await getTokenHistory()
      setTokenHistory(freshHistory)
    } catch (err) {
      setError(err.message)
    }
  }

  const handleBulkDeleteExpired = async () => {
    const expiredCount = tokenHistory.filter(t => !t.active).length
    if (!expiredCount) return
    if (!window.confirm(`Delete ${expiredCount} expired tokens? This action cannot be undone.`)) return
    setError('')
    setMessage('')
    try {
      const deleted = await bulkDeleteExpiredTokens()
      setMessage(`Deleted ${deleted} expired tokens.`)
      const freshHistory = await getTokenHistory()
      setTokenHistory(freshHistory)
    } catch (err) {
      setError(err.message)
    }
  }

  const handleCopyToken = async (token) => {
    try {
      await navigator.clipboard.writeText(token)
      setMessage('Token copied to clipboard.')
    } catch {
      setError('Clipboard copy not available in this browser.')
    }
  }

  const exportAttendanceRange = () => {
    const rows = attendanceRangeData.map((log) => ({
      Date: log.date,
      Time: log.clientTs,
      Employee: log.employeeName,
      Action: log.action,
      Token: log.token,
      GPS: log.gps ? `${log.gps.lat},${log.gps.lng}` : '',
    }))
    downloadCsv(`attendance-${attendanceRangeStart}-to-${attendanceRangeEnd}.csv`, rows)
    setMessage(`Exported ${rows.length} records.`)
  }

  const openEmployeeDetail = (employee) => {
    if (!employee) return
    setEmployeeDetail(employee)
    setEmployeeDetailMonth(salaryMonth || getTodayKey().slice(0, 7))
    setEmployeeDetailDateKey('')
  }

  const closeEmployeeDetail = () => {
    setEmployeeDetail(null)
    setEmployeeDetailRows([])
    setEmployeeDetailDateKey('')
  }

  const openEmployeeAttendance = () => {
    if (!employeeDetail?.uid) return
    setSection('attendance')
    setSelectedEmployee(employeeDetail.uid)
    setAttendanceView('summary')
    setDate(employeeDetailRows[0]?.date || date)
    setDateTouched(true)
    closeEmployeeDetail()
  }

  const openEmployeeSalary = () => {
    if (!employeeDetail?.uid) return
    setSection('salary')
    setSalaryView('monthly')
    setSalaryMonth(employeeDetailMonth)
    setSalarySelectedUserId(employeeDetail.uid)
    setSalarySelectedDateKey('')
    closeEmployeeDetail()
  }

  const employeeDetailState = {
    employeeDetail,
    setEmployeeDetail,
    employeeDetailMonth,
    setEmployeeDetailMonth,
    employeeDetailDateKey,
    setEmployeeDetailDateKey,
    employeeDetailRows,
    setEmployeeDetailRows,
    employeeDetailLoading,
    setEmployeeDetailLoading,
  }
  void employeeDetailState

  const printPayslip = (selected) => {
    if (!selected) return
    const summary = salarySelectedAttendanceSummary
    const selectedDayKey = salarySelectedDateKey || `${salaryMonth}-01`
    const selectedDay = salarySelectedAttendanceMap.get(selectedDayKey) || null
    const rowsHtml = salarySelectedAttendanceRows
      .slice(0, 12)
      .map((row) => `
        <tr>
          <td>${escapeHtml(row.date || '-')}</td>
          <td>${escapeHtml(row.checkInAt ? formatClock(row.checkInAt) : '-')}</td>
          <td>${escapeHtml(row.checkOutAt ? formatClock(row.checkOutAt) : '-')}</td>
          <td>${escapeHtml(formatDurationMs(Number(row.workedMinutes || 0) * 60000))}</td>
          <td>${escapeHtml(Math.round((Number(row.overtimeMinutes || 0) / 60) * 100) / 100)}h</td>
          <td>${escapeHtml(Number(row.overtimePay || 0).toLocaleString())}</td>
        </tr>
      `)
      .join('')

    const popup = window.open('', '_blank', 'width=900,height=1200')
    if (!popup) {
      setError('Popup blocked. Allow popups to print a payslip.')
      return
    }

    popup.document.open()
    popup.document.write(`
      <!doctype html>
      <html>
        <head>
          <title>Payslip ${escapeHtml(selected.employeeName)} ${escapeHtml(selected.month)}</title>
          <style>
            @page { size: A4; margin: 18mm; }
            body { font-family: Arial, sans-serif; color: #111; }
            .sheet { max-width: 760px; margin: 0 auto; }
            .top { display: flex; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
            h1, h2, h3, p { margin: 0; }
            h1 { font-size: 24px; }
            h2 { font-size: 18px; margin-top: 4px; }
            .muted { color: #555; }
            .box { border: 1px solid #ddd; border-radius: 12px; padding: 14px; margin-top: 12px; }
            .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; }
            .grid p { padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
            .grid strong { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; margin-bottom: 4px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th, td { border-bottom: 1px solid #eee; padding: 8px 6px; text-align: left; font-size: 12px; }
            th { color: #666; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; }
            .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
            .summary div { border: 1px solid #ddd; border-radius: 10px; padding: 10px; }
            .summary strong { display: block; font-size: 18px; margin-top: 4px; }
            .footer { margin-top: 12px; font-size: 12px; color: #666; }
            @media print { .no-print { display: none; } }
          </style>
        </head>
        <body>
          <div class="sheet">
            <div class="top">
              <div>
                <h1>Payroll Payslip</h1>
                <h2>${escapeHtml(selected.employeeName)}</h2>
                <p class="muted">${escapeHtml(selected.month)} • UID ${escapeHtml(selected.userId)}</p>
              </div>
              <div style="text-align:right">
                <p class="muted">Generated by ScanTrack</p>
                <p class="muted">${escapeHtml(new Date().toLocaleString())}</p>
              </div>
            </div>

            <div class="summary">
              <div><span class="muted">Final Salary</span><strong>${escapeHtml(Number(selected.finalSalary || 0).toLocaleString())}</strong></div>
              <div><span class="muted">Attendance Base</span><strong>${escapeHtml(Number(selected.attendanceBase || 0).toLocaleString())}</strong></div>
              <div><span class="muted">OT Pay</span><strong>${escapeHtml(Number(selected.overtimePay || 0).toLocaleString())}</strong></div>
              <div><span class="muted">Deductions</span><strong>${escapeHtml(Number(selected.deductions || 0).toLocaleString())}</strong></div>
            </div>

            <div class="box">
              <h3>Attendance Summary</h3>
              <div class="grid">
                <p><strong>Present</strong>${escapeHtml(selected.daysPresent)}</p>
                <p><strong>Late Days</strong>${escapeHtml(selected.lateDays)}</p>
                <p><strong>Checked Out</strong>${escapeHtml(summary.checkedOut)}</p>
                <p><strong>Overtime Days</strong>${escapeHtml(summary.overtime)}</p>
                <p><strong>Overtime Minutes</strong>${escapeHtml(summary.totalOvertimeMinutes)}</p>
                <p><strong>Paid Leave</strong>${escapeHtml(selected.paidLeave)}</p>
                <p><strong>Unpaid Leave</strong>${escapeHtml(selected.unpaidLeave)}</p>
                <p><strong>Expected Days</strong>${escapeHtml(selected.expectedWorkDays)}</p>
              </div>
            </div>

            <div class="box">
              <h3>Selected Day</h3>
              <div class="grid">
                <p><strong>Date</strong>${escapeHtml(selectedDayKey)}</p>
                <p><strong>Status</strong>${escapeHtml(selectedDay?.checkInAt ? (selectedDay?.checkOutAt ? 'Present' : 'Open shift') : 'Absent')}</p>
                <p><strong>Check In</strong>${escapeHtml(selectedDay?.checkInAt ? formatClock(selectedDay.checkInAt) : '-')}</p>
                <p><strong>Check Out</strong>${escapeHtml(selectedDay?.checkOutAt ? formatClock(selectedDay.checkOutAt) : '-')}</p>
                <p><strong>Worked</strong>${escapeHtml(formatDurationMs(Number(selectedDay?.workedMinutes || 0) * 60000))}</p>
                <p><strong>Season</strong>${escapeHtml(selectedDay?.overtimeLabel || '-')}</p>
              </div>
            </div>

            <div class="box">
              <h3>Month Attendance Snapshot</h3>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Worked</th>
                    <th>OT</th>
                    <th>OT Pay</th>
                  </tr>
                </thead>
                <tbody>
                  ${rowsHtml || '<tr><td colspan="6">No attendance records available.</td></tr>'}
                </tbody>
              </table>
            </div>

            <p class="footer">This payslip can be saved as PDF from the browser print dialog.</p>
          </div>
          <script>
            window.onload = () => {
              window.focus();
              window.print();
            };
          </script>
        </body>
      </html>
    `)
    popup.document.close()
  }

  const dashboardDays = useMemo(() => {
    const days = []
    const start = dashboardRange === 'month' ? -29 : -6
    for (let i = start; i <= 0; i += 1) {
      days.push(shiftDateKey(date, i))
    }
    return days
  }, [dashboardRange, date])

  const dashboardTrend = useMemo(() => {
    const byDate = new Map()
    for (const row of dashboardRangeRows) {
      const key = row.date || row.day || ''
      if (!key) continue
      const next = byDate.get(key) || {
        date: key,
        checkIns: 0,
        late: 0,
        checkOuts: 0,
        missingCheckout: 0,
        overtimeCount: 0,
        overtimeMinutes: 0,
      }
      if (row.checkInAt) next.checkIns += 1
      if (row.late) next.late += 1
      if (row.checkOutAt) next.checkOuts += 1
      if (row.checkInAt && !row.checkOutAt) next.missingCheckout += 1
      const overtimeMinutes = Number(row.overtimeMinutes || 0)
      if (overtimeMinutes > 0) {
        next.overtimeCount += 1
        next.overtimeMinutes += overtimeMinutes
      }
      byDate.set(key, next)
    }

    const rows = dashboardDays.map((key) => byDate.get(key) || {
      date: key,
      checkIns: 0,
      late: 0,
      checkOuts: 0,
      missingCheckout: 0,
      overtimeCount: 0,
      overtimeMinutes: 0,
    })
    const maxCheckIns = Math.max(1, ...rows.map((row) => row.checkIns))
    const maxLate = Math.max(1, ...rows.map((row) => row.late))
    return {
      rows,
      maxCheckIns,
      maxLate,
      totalCheckIns: rows.reduce((sum, row) => sum + row.checkIns, 0),
      totalLate: rows.reduce((sum, row) => sum + row.late, 0),
      totalOvertimeMinutes: rows.reduce((sum, row) => sum + row.overtimeMinutes, 0),
      totalMissingCheckout: rows.reduce((sum, row) => sum + row.missingCheckout, 0),
      totalOvertimeRows: rows.reduce((sum, row) => sum + row.overtimeCount, 0),
    }
  }, [dashboardDays, dashboardRangeRows])

  const dashboardWarnings = useMemo(() => {
    const openShifts = dashboardTrend.rows
      .filter((row) => row.missingCheckout > 0)
      .slice(-6)
      .map((row) => ({
        kind: 'missing',
        date: row.date,
        value: row.missingCheckout,
      }))
    const overtimeRows = dashboardTrend.rows
      .filter((row) => row.overtimeCount > 0)
      .slice(-6)
      .map((row) => ({
        kind: 'overtime',
        date: row.date,
        value: Math.round((row.overtimeMinutes / 60) * 100) / 100,
      }))
    const combined = [...openShifts, ...overtimeRows]
    return combined.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6)
  }, [dashboardTrend.rows])

  const attendanceDirectoryRows = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return directory.filter((entry) => {
      const byEmployee = selectedEmployee === 'all' || entry.uid === selectedEmployee
      const status = String(entry.status || '').toLowerCase()
      const hasCheckIn = Boolean(entry.checkInAt)
      const hasCheckOut = Boolean(entry.checkOutAt)
      const hasOvertime = Number(entry.overtimeMinutes || 0) > 0
      const matchesQuickFilter =
        attendanceQuickFilter === 'all' ||
        (attendanceQuickFilter === 'checkedIn' && hasCheckIn) ||
        (attendanceQuickFilter === 'late' && Boolean(entry.late)) ||
        (attendanceQuickFilter === 'checkedOut' && hasCheckOut) ||
        (attendanceQuickFilter === 'missingCheckout' && hasCheckIn && !hasCheckOut) ||
        (attendanceQuickFilter === 'overtime' && hasOvertime)
      if (!matchesQuickFilter || !byEmployee) return false
      if (!keyword) return true
      const name = String(entry.name || '').toLowerCase()
      const email = String(entry.email || '').toLowerCase()
      const uid = String(entry.uid || entry.id || '').toLowerCase()
      return name.includes(keyword) || email.includes(keyword) || uid.includes(keyword) || status.includes(keyword)
    })
  }, [attendanceQuickFilter, directory, search, selectedEmployee])

  const filteredDirectoryForAttendance = attendanceDirectoryRows

  const salarySelectedEmployee = useMemo(() => {
    if (!salarySelectedUserId) return null
    return (
      filteredSalaryRows.find((row) => row.userId === salarySelectedUserId) ||
      salaryRows.find((row) => row.userId === salarySelectedUserId) ||
      null
    )
  }, [filteredSalaryRows, salaryRows, salarySelectedUserId])

  const salarySelectedAttendanceMap = useMemo(() => {
    const map = new Map()
    for (const row of salarySelectedAttendanceRows) {
      map.set(row.date, row)
    }
    return map
  }, [salarySelectedAttendanceRows])

  const salarySelectedAttendanceSummary = useMemo(() => {
    const rows = salarySelectedAttendanceRows
    const present = rows.filter((row) => row.checkInAt).length
    const late = rows.filter((row) => row.late).length
    const checkedOut = rows.filter((row) => row.checkOutAt).length
    const overtime = rows.filter((row) => Number(row.overtimeMinutes || 0) > 0).length
    const totalOvertimeMinutes = rows.reduce((sum, row) => sum + Number(row.overtimeMinutes || 0), 0)
    return {
      present,
      late,
      checkedOut,
      overtime,
      totalOvertimeMinutes,
    }
  }, [salarySelectedAttendanceRows])

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
    <main className="layout admin-workspace" data-tick={uiTick}>
      <div className="toast-stack" aria-live="polite" aria-relevant="additions">
        {message ? (
          <div className="toast toast-success">
            <strong>Done</strong>
            <span className="toast-text">{message}</span>
            <button type="button" className="toast-close" onClick={() => setMessage('')} aria-label="Dismiss">×</button>
          </div>
        ) : null}
        {error ? (
          <div className="toast toast-error" aria-live="assertive">
            <strong>Action failed</strong>
            <span className="toast-text">{error}</span>
            <button type="button" className="toast-close" onClick={() => setError('')} aria-label="Dismiss">×</button>
          </div>
        ) : null}
      </div>
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
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Live attendance and payroll insights for the selected range.
                </p>
              </div>
              <div className="row gap wrap dashboard-actions">
                <div className="segmented dashboard-range" role="tablist" aria-label="Dashboard range">
                  <button type="button" className={dashboardRange === 'week' ? 'active' : ''} onClick={() => setDashboardRange('week')}>
                    Week
                  </button>
                  <button type="button" className={dashboardRange === 'month' ? 'active' : ''} onClick={() => setDashboardRange('month')}>
                    Month
                  </button>
                </div>
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
              <article className="card stat-card ok"><h3>GPS Active</h3><p>Verification Enabled</p></article>
            </section>

            <section className="dashboard-grid">
              <section className="card dashboard-chart-card">
                <div className="row between wrap">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>{dashboardRange === 'month' ? 'Last 30 Days' : 'Last 7 Days'} - Attendance Trend</h3>
                    <p className="muted" style={{ margin: 0 }}>
                      Check-ins, late arrivals, and overtime over the selected range.
                    </p>
                  </div>
                  <div className="inline-pills">
                    <span className="pill neutral">Check-ins {dashboardTrend.totalCheckIns}</span>
                    <span className="pill danger">Late {dashboardTrend.totalLate}</span>
                    <span className="pill ok">OT {Math.round((dashboardTrend.totalOvertimeMinutes / 60) * 100) / 100}h</span>
                  </div>
                </div>
                <div className="mini-chart trend-chart">
                  {dashboardRangeLoading ? (
                    <div className="trend-loading muted">Loading range data...</div>
                  ) : null}
                  {dashboardTrend.rows.map((row) => {
                    const label = new Date(`${row.date}T12:00:00.000Z`).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })
                    const checkInHeight = `${Math.max(10, (row.checkIns / dashboardTrend.maxCheckIns) * 120)}px`
                    const lateHeight = `${Math.max(8, (row.late / dashboardTrend.maxLate) * 92)}px`
                    const overtimeHeight = `${Math.max(8, Math.min(120, (row.overtimeMinutes / 60) * 18))}px`
                    return (
                      <div key={row.date} className="mini-col">
                        <div className="mini-stack">
                          <div className="mini-seg late" style={{ height: lateHeight }} title={`Late: ${row.late}`} />
                          <div className="mini-seg ontime" style={{ height: checkInHeight }} title={`Check-ins: ${row.checkIns}`} />
                          <div className="mini-seg overtime" style={{ height: overtimeHeight }} title={`Overtime: ${Math.round((row.overtimeMinutes / 60) * 100) / 100}h`} />
                        </div>
                        <span>{dashboardRange === 'week' ? label.split(' ').pop() : label}</span>
                      </div>
                    )
                  })}
                </div>
              </section>

              <aside className="card dashboard-side-card">
                <div className="dashboard-side-block">
                  <h3>Quick Actions</h3>
                  <div className="dashboard-actions-list">
                    <button type="button" className="ghost" onClick={() => setSection('attendance')}>Open Attendance</button>
                    <button type="button" className="ghost" onClick={() => setSection('salary')}>Open Salary</button>
                    <button type="button" className="ghost" onClick={() => setSection('qrcodes')}>Manage QR Tokens</button>
                    <button type="button" className="ghost" onClick={() => setSection('alerts')}>Review Alerts</button>
                  </div>
                </div>
                <div className="dashboard-side-block">
                  <h3>Watchlist</h3>
                  {dashboardWarnings.length ? (
                    <div className="dashboard-warning-list">
                      {dashboardWarnings.map((item) => (
                        <article key={`${item.kind}-${item.date}`} className="dashboard-warning-row">
                          <span className={`pill ${item.kind === 'overtime' ? 'ok' : 'danger'}`}>
                            {item.kind === 'overtime' ? 'Overtime' : 'Missing checkout'}
                          </span>
                          <strong>{item.date}</strong>
                          <span className="muted">
                            {item.kind === 'overtime' ? `${item.value}h logged` : `${item.value} open shift${item.value === 1 ? '' : 's'}`}
                          </span>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted" style={{ margin: 0 }}>
                      No dashboard warnings for the selected range.
                    </p>
                  )}
                </div>
              </aside>
            </section>

            <section className="card">
              <h3>Recent Activity</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Name</th><th>Email</th><th>Type</th><th>Status</th><th>Time</th></tr>
                  </thead>
                  <tbody>
                    {dashboardSummary.recent.map((log) => (
                      <tr key={log.id}>
                        <td>{log.employeeName}</td>
                        <td>
                          <div className="recent-email-cell">
                            <span>{employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || '-'}</span>
                            <code className="muted">{log.userId}</code>
                          </div>
                        </td>
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
              <div className="attendance-hero-copy">
                <p className="eyebrow">Attendance Log</p>
                <h1>Records, insights, and exports</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Showing {attendanceSummary.filteredTotal} of {attendanceSummary.dateTotal} records for {date}
                  {attendanceSummary.filtersActive ? ` • ${attendanceSummary.filtersActive} filter${attendanceSummary.filtersActive === 1 ? '' : 's'} active` : ''}
                </p>
                <div className="inline-pills" style={{ marginTop: 10 }}>
                  <span className={`pill ${scheduleForSelectedDate.enabled ? 'ok' : 'danger'}`}>
                    {scheduleForSelectedDate.enabled ? 'Open day' : 'Closed day'}
                  </span>
                  <span className="pill neutral">
                    {scheduleForSelectedDate.workStart}–{scheduleForSelectedDate.workEnd} • grace {scheduleForSelectedDate.graceMins}m
                  </span>
                  <span className={`pill ${scheduleForSelectedDate.allowCheckIn ? 'ok' : 'neutral'}`}>Check-in {scheduleForSelectedDate.allowCheckIn ? 'On' : 'Off'}</span>
                  <span className={`pill ${scheduleForSelectedDate.allowCheckOut ? 'ok' : 'neutral'}`}>Check-out {scheduleForSelectedDate.allowCheckOut ? 'On' : 'Off'}</span>
                  <button type="button" className="ghost btn-sm" onClick={() => setSection('settings')}>
                    Edit schedule
                  </button>
                </div>
                <div className="inline-pills" style={{ marginTop: 12 }}>
                  {[
                    ['all', 'All'],
                    ['checkedIn', 'Checked in'],
                    ['late', 'Late'],
                    ['checkedOut', 'Checked out'],
                    ['missingCheckout', 'Missing checkout'],
                    ['overtime', 'Overtime'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`pill ${attendanceQuickFilter === key ? 'ok' : 'neutral'} attendance-filter-chip`}
                      onClick={() => setAttendanceQuickFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="attendance-hero-side">
                <div className="attendance-actions">
                <div className="segmented" role="tablist" aria-label="Attendance view">
                  <button
                    type="button"
                    className={attendanceView === 'logs' ? 'active' : ''}
                    onClick={() => setAttendanceView('logs')}
                  >
                    Logs
                  </button>
                  <button
                    type="button"
                    className={attendanceView === 'summary' ? 'active' : ''}
                    onClick={() => setAttendanceView('summary')}
                  >
                    Daily summary
                  </button>
                </div>
                <div className="row gap wrap attendance-utility-actions">
                  <button className="ghost" onClick={() => exportExcel(`attendance-${date}.xlsx`, logExportRows)}>Excel</button>
                  <button className="ghost" onClick={() => downloadCsv(`attendance-${date}.csv`, logExportRows)}>CSV</button>
                  <button className="ghost danger" onClick={clearToday}>Clear All</button>
                </div>
              </div>
                <div className="attendance-hero-summary">
                  <article>
                    <span>Today</span>
                    <strong>{attendanceSummary.dateCheckIns}</strong>
                  </article>
                  <article>
                    <span>Late</span>
                    <strong>{attendanceSummary.dateLate}</strong>
                  </article>
                  <article>
                    <span>OT</span>
                    <strong>{Math.round((dashboardTrend.totalOvertimeMinutes / 60) * 100) / 100}h</strong>
                  </article>
                </div>
              </div>
            </section>

            <section className="stats-grid six">
              <article className="card stat-card">
                <h3>{attendanceSummary.dateUniqueStaff}</h3>
                <p>Unique employees</p>
              </article>
              <article className="card stat-card">
                <h3>{attendanceSummary.dateCheckIns}</h3>
                <p>Check-ins</p>
              </article>
              <article className="card stat-card danger">
                <h3>{attendanceSummary.dateLate}</h3>
                <p>Late arrivals</p>
              </article>
              <article className="card stat-card">
                <h3>{attendanceSummary.dateCheckOuts}</h3>
                <p>Check-outs</p>
              </article>
              <article className="card stat-card">
                <h3>{attendanceSummary.dateOnTimePercent}%</h3>
                <p>On-time rate</p>
              </article>
              <article className="card stat-card">
                <h3>{directorySummary.checkedIn}</h3>
                <p>Checked in (daily)</p>
              </article>
            </section>

            <section className="card">
              <div className="grid filters wide attendance-filters">
                <label>Date<input type="date" value={date} onChange={(e) => { setDateTouched(true); setDate(e.target.value) }} /></label>
                <label>Search<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / email / id" /></label>
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
                <div className="filter-action-cell">
                  <span>Actions</span>
                  <button type="button" className="ghost" onClick={resetAttendanceFilters}>
                    Reset Filters
                  </button>
                </div>
                <label className="toggle-inline attendance-gps-toggle">
                  <span>Show GPS</span>
                  <input type="checkbox" checked={showGpsColumn} onChange={(e) => setShowGpsColumn(e.target.checked)} />
                </label>
              </div>
              {attendanceQuickFilter !== 'all' ? (
                <div className="inline-pills attendance-quick-strip" style={{ marginTop: 12 }}>
                  <span className="pill neutral">Quick filter: {attendanceQuickFilter}</span>
                  <button type="button" className="ghost btn-sm" onClick={() => setAttendanceQuickFilter('all')}>
                    Clear quick filter
                  </button>
                </div>
              ) : null}
              {attendanceView === 'logs' ? (
                <>
                  <div className="table-wrap admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Type</th>
                          <th>Status</th>
                          <th>Date</th>
                          <th>Time</th>
                          {showGpsColumn && <th>GPS</th>}
                          {showGpsColumn && <th>Map</th>}
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paginatedLogs.map((log, index) => (
                          <tr key={log.id || `${log.userId}-${index}`} className="attendance-log-row">
                            <td>{(attendancePage - 1) * PAGE_SIZE + index + 1}</td>
                            <td>{log.employeeName}</td>
                            <td>
                              <div className="recent-email-cell">
                                <span>{employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || '-'}</span>
                                <code className="muted">{log.userId}</code>
                              </div>
                            </td>
                            <td><span className="pill neutral">{log.action === 'checkIn' ? 'Check In' : 'Check Out'}</span></td>
                            <td>{log.action === 'checkIn' ? <span className={`pill ${log.late ? 'danger' : 'ok'}`}>{log.late ? 'Late' : 'On Time'}</span> : '-'}</td>
                            <td>{log.date}</td>
                            <td>
                              <div className="row gap wrap">
                                <span>{formatClock(log.clientTs)}</span>
                                <span className="muted" style={{ fontSize: '0.82rem' }}>{formatRelative(log.clientTs)}</span>
                              </div>
                            </td>
                            {showGpsColumn && (
                              <td>
                                <span className="gps-coord">
                                  {log.gps ? `${log.gps.lat?.toFixed(4)},${log.gps.lng?.toFixed(4)}` : '-'}
                                </span>
                              </td>
                            )}
                            {showGpsColumn && (
                              <td>
                                {log.gps?.lat && log.gps?.lng ? (
                                  <a
                                    className="ghost btn-sm"
                                    href={`https://www.google.com/maps?q=${encodeURIComponent(`${log.gps.lat},${log.gps.lng}`)}`}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    Open
                                  </a>
                                ) : (
                                  <span className="muted">-</span>
                                )}
                              </td>
                            )}
                            <td>
                              <div className="row gap wrap attendance-row-actions">
                                <button
                                  type="button"
                                  className="ghost btn-sm"
                                  onClick={() => openEmployeeDetail(employeeLookupById.get(String(log.userId)) || {
                                    uid: log.userId,
                                    name: log.employeeName,
                                    email: employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || '',
                                  })}
                                >
                                  Detail
                                </button>
                                <button
                                  type="button"
                                  className="ghost btn-sm"
                                  onClick={async () => {
                                    const email = employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || ''
                                    try {
                                      await navigator.clipboard.writeText(email || String(log.userId || ''))
                                      setMessage(email ? 'Employee email copied.' : 'Employee id copied.')
                                    } catch {
                                      setError('Clipboard copy not available in this browser.')
                                    }
                                  }}
                                >
                                  Copy
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {!paginatedLogs.length && (
                          <tr><td colSpan={showGpsColumn ? 10 : 8} className="muted">No records found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="attendance-log-cards">
                    {paginatedLogs.map((log, index) => {
                      const email = employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || '-'
                      return (
                        <article key={`card-${log.id || `${log.userId}-${index}`}`} className="card attendance-log-card">
                          <div className="attendance-log-card-head">
                            <div>
                              <p className="eyebrow" style={{ marginBottom: 6 }}>#{(attendancePage - 1) * PAGE_SIZE + index + 1}</p>
                              <h3 style={{ marginBottom: 4 }}>{log.employeeName}</h3>
                              <div className="recent-email-cell">
                                <span>{email}</span>
                                <code className="muted">{log.userId}</code>
                              </div>
                            </div>
                            <div className="attendance-log-card-meta">
                              <span className="pill neutral">{log.action === 'checkIn' ? 'Check In' : 'Check Out'}</span>
                              {log.action === 'checkIn' ? <span className={`pill ${log.late ? 'danger' : 'ok'}`}>{log.late ? 'Late' : 'On Time'}</span> : null}
                            </div>
                          </div>
                          <div className="attendance-log-card-grid">
                            <div><span>Date</span><strong>{log.date}</strong></div>
                            <div><span>Time</span><strong>{formatClock(log.clientTs)}</strong><small>{formatRelative(log.clientTs)}</small></div>
                            <div><span>GPS</span><strong>{log.gps ? `${log.gps.lat?.toFixed(4)}, ${log.gps.lng?.toFixed(4)}` : '-'}</strong></div>
                            <div><span>Map</span><strong>{log.gps?.lat && log.gps?.lng ? 'Available' : '-'}</strong></div>
                          </div>
                          <div className="row gap wrap attendance-row-actions attendance-log-card-actions">
                            <button
                              type="button"
                              className="ghost btn-sm"
                              onClick={() => openEmployeeDetail(employeeLookupById.get(String(log.userId)) || {
                                uid: log.userId,
                                name: log.employeeName,
                                email,
                              })}
                            >
                              Detail
                            </button>
                            <button
                              type="button"
                              className="ghost btn-sm"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(email || String(log.userId || ''))
                                  setMessage(email ? 'Employee email copied.' : 'Employee id copied.')
                                } catch {
                                  setError('Clipboard copy not available in this browser.')
                                }
                              }}
                            >
                              Copy
                            </button>
                            {log.gps?.lat && log.gps?.lng ? (
                              <a
                                className="ghost btn-sm"
                                href={`https://www.google.com/maps?q=${encodeURIComponent(`${log.gps.lat},${log.gps.lng}`)}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open map
                              </a>
                            ) : null}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                  <div className="row between table-footer">
                    <p className="muted">{filteredLogs.length} record{filteredLogs.length === 1 ? '' : 's'}</p>
                    <div className="row gap">
                      <button type="button" className="ghost" disabled={attendancePage <= 1} onClick={() => setAttendancePage((page) => Math.max(1, page - 1))}>Prev</button>
                      <span className="muted">Page {attendancePage} / {attendancePages}</span>
                      <button type="button" className="ghost" disabled={attendancePage >= attendancePages} onClick={() => setAttendancePage((page) => Math.min(attendancePages, page + 1))}>Next</button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="table-wrap admin-table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>ID</th>
                          <th>Status</th>
                          <th>Check In</th>
                          <th>Check Out</th>
                          <th>Worked</th>
                          <th>OT</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredDirectoryForAttendance.map((item) => {
                          const inMs = item.checkInAt ? new Date(item.checkInAt).getTime() : NaN
                          const outMs = item.checkOutAt ? new Date(item.checkOutAt).getTime() : NaN
                          const worked = Number.isFinite(inMs) && Number.isFinite(outMs) ? outMs - inMs : NaN
                          return (
                            <tr key={item.uid || item.email || item.name} className="attendance-summary-row">
                              <td>{item.name || item.email}</td>
                              <td>
                                <div className="recent-email-cell">
                                  <span>{item.email || '-'}</span>
                                  <code className="muted">{item.uid}</code>
                                </div>
                              </td>
                              <td><span className={`pill ${item.late ? 'danger' : 'neutral'}`}>{item.status}</span></td>
                              <td>{formatClock(item.checkInAt)}</td>
                              <td>{formatClock(item.checkOutAt)}</td>
                              <td>{formatDurationMs(worked)}</td>
                              <td>{Number(item.overtimeMinutes || 0) > 0 ? <span className="pill ok">{Math.round((Number(item.overtimeMinutes || 0) / 60) * 100) / 100}h OT</span> : <span className="muted">-</span>}</td>
                              <td>
                                <div className="row gap wrap attendance-row-actions">
                                  <button
                                    type="button"
                                    className="ghost btn-sm"
                                    onClick={() => openEmployeeDetail(item)}
                                  >
                                    Detail
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost btn-sm"
                                    onClick={() => {
                                      setSelectedEmployee(item.uid)
                                      setAttendanceView('logs')
                                      setStatusFilter(item.late ? 'late' : 'all')
                                      setAttendancePage(1)
                                    }}
                                  >
                                    Logs
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                        {!filteredDirectoryForAttendance.length && (
                          <tr><td colSpan={8} className="muted">No employees found for this date.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="row between table-footer">
                    <p className="muted">
                      {filteredDirectoryForAttendance.length} employee{filteredDirectoryForAttendance.length === 1 ? '' : 's'} •
                      {' '}{directorySummary.checkedIn} checked in • {directorySummary.checkedOut} checked out • {directorySummary.late} late
                    </p>
                    <button type="button" className="ghost" onClick={() => { setAttendanceView('logs'); setAttendancePage(1) }}>
                      Back to logs
                    </button>
                  </div>
                </>
              )}
            </section>
          </>
        )}

        {section === 'employees' && (
          <>
            <section className="card admin-top-row">
              <div className="employee-hero-copy">
                <p className="eyebrow">Employee Directory</p>
                <h1>Today&apos;s check-in status</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Search staff, sort by status, and open a detailed monthly view from any card.
                </p>
              </div>
              <div className="employee-hero-side">
                <div className="admin-top-actions">
                  <input
                    value={employeeSearch}
                    onChange={(event) => setEmployeeSearch(event.target.value)}
                    placeholder="Search name / email / id"
                  />
                </div>
                <div className="employee-quick-actions">
                  <button type="button" className="ghost btn-sm" onClick={() => setEmployeeSearch('')}>Clear search</button>
                  <button
                    type="button"
                    className="ghost btn-sm"
                    onClick={() => downloadCsv(`employees-${date}.csv`, directoryRows.map((item) => ({
                      Name: item.name || item.email || '-',
                      Email: item.email || '-',
                      UID: item.uid || '-',
                      Role: item.role || 'employee',
                      Status: item.active === false ? 'Inactive' : item.status || '-',
                      'Daily Rate': item.dailyRate || 0,
                      'Allowed Holidays': item.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 1,
                    })))}
                  >
                    Export CSV
                  </button>
                  <button type="button" className="ghost btn-sm" onClick={() => { setSection('attendance'); setAttendanceView('summary') }}>
                    Open summary
                  </button>
                </div>
              </div>
            </section>

            <section className="stats-grid">
              <article className="card stat-card">
                <h3>{directorySummary.totalEmployees}</h3>
                <p>Active employees</p>
              </article>
              <article className="card stat-card">
                <h3>{directorySummary.checkedIn}</h3>
                <p>Checked in</p>
              </article>
              <article className="card stat-card danger">
                <h3>{directorySummary.late}</h3>
                <p>Late</p>
              </article>
              <article className="card stat-card">
                <h3>{directorySummary.checkedOut}</h3>
                <p>Checked out</p>
              </article>
            </section>

            <section className="card employee-toolbar">
              <div className="employee-toolbar-row">
                <label>Sort
                  <select value={employeeSort} onChange={(e) => setEmployeeSort(e.target.value)}>
                    <option value="status">Status first</option>
                    <option value="name">Name A-Z</option>
                    <option value="email">Email A-Z</option>
                    <option value="late">Late first</option>
                    <option value="recent">Recently active</option>
                  </select>
                </label>
                <label>Status
                  <select value={employeeStatusFilter} onChange={(e) => setEmployeeStatusFilter(e.target.value)}>
                    <option value="all">All status</option>
                    <option value="checkedIn">Checked in</option>
                    <option value="late">Late</option>
                    <option value="checkedOut">Checked out</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
                <label>Role
                  <select value={employeeRoleFilter} onChange={(e) => setEmployeeRoleFilter(e.target.value)}>
                    <option value="all">All roles</option>
                    <option value="employee">Employee</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <label className="toggle-inline employee-toggle">
                  <span>Show inactive</span>
                  <input type="checkbox" checked={showInactiveEmployees} onChange={(e) => setShowInactiveEmployees(e.target.checked)} />
                </label>
              </div>
              <div className="inline-pills employee-legend">
                <span className="pill ok">On time</span>
                <span className="pill danger">Late</span>
                <span className="pill neutral">Checked out</span>
                <span className="pill neutral">Inactive hidden</span>
              </div>
            </section>

            <section className="card">
              <div className="row between wrap" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>{editingEmployeeId ? 'Edit Employee' : 'Add Employee'}</h3>
                  <p className="muted" style={{ margin: 0 }}>Grant access to sign-in and track attendance.</p>
                </div>
                {editingEmployeeId ? (
                  <button type="button" className="ghost btn-sm" onClick={cancelEditEmployee}>Cancel edit</button>
                ) : null}
              </div>

              <form className="employee-form" onSubmit={createEmployee}>
                <div className="employee-form-grid">
                  <label>Name<input value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} required /></label>
                  <label>Email<input type="email" value={newEmpEmail} onChange={(e) => setNewEmpEmail(e.target.value)} required /></label>
                  <label>Permission Role
                    <select value={newEmpRole} onChange={(e) => setNewEmpRole(e.target.value)}>
                      <option value="employee">Employee</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                  <label>Payroll Role (optional)
                    <select value={newEmpRoleName} onChange={(e) => setNewEmpRoleName(e.target.value)}>
                      <option value="">No payroll role</option>
                      {roles.map((role) => (
                        <option key={role.id || role.roleName} value={role.roleName}>{role.roleName} ({role.payType})</option>
                      ))}
                    </select>
                  </label>
                  <label>Daily Rate
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={newEmpDailyRate}
                      onChange={(e) => setNewEmpDailyRate(e.target.value)}
                      placeholder="e.g. 2500"
                    />
                  </label>
                  <label>Paid Holidays
                    <input
                      type="number"
                      min="0"
                      value={newEmpAllowedHolidays}
                      onChange={(e) => setNewEmpAllowedHolidays(e.target.value)}
                      placeholder="e.g. 1"
                    />
                  </label>
                  <div className="employee-form-actions">
                    <button type="submit" disabled={savingEmployee}>
                      {savingEmployee ? 'Saving...' : editingEmployeeId ? 'Save Employee' : 'Add Employee'}
                    </button>
                  </div>
                </div>
              </form>
            </section>

            <section className="employee-grid">
              {directoryRows.map((item) => (
                <article key={item.uid || item.email || item.name} className="card emp-card">
                  <div className="emp-card-head">
                    <div className={`emp-avatar ${item.active === false ? 'inactive' : ''}`}>{(item.name || 'E').slice(0, 2).toUpperCase()}</div>
                    <div className="emp-card-title">
                      <h3>{item.name}</h3>
                      <p className="muted">{item.email}</p>
                    </div>
                    <span className={`pill ${item.late ? 'danger' : 'neutral'}`}>{item.status}</span>
                  </div>
                  <div className="emp-meta">
                    <span className="muted">{item.roleName ? `Payroll role: ${item.roleName}` : 'Payroll role: None'}</span>
                    <span className="muted">{item.checkInAt ? `In ${formatClock(item.checkInAt)}` : 'No check-in yet'}</span>
                    <span className="muted">{item.checkOutAt ? `Out ${formatClock(item.checkOutAt)}` : 'No check-out yet'}</span>
                    <span className="muted">Rate {Number(item.dailyRate || 0).toLocaleString()} • Holidays {Number(item.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 1)}</span>
                  </div>
                  <div className="emp-card-actions">
                    <button type="button" className="ghost" onClick={() => openEmployeeDetail(item)}>View detail</button>
                    <button type="button" className="ghost" onClick={() => startEditEmployee(item)}>Edit</button>
                    <button 
                      type="button" 
                      className="ghost" 
                      onClick={async () => {
                        const inviteUrl = `${window.location.origin}/employee?i=${encodeURIComponent(item.email)}`
                        try {
                          await navigator.clipboard.writeText(inviteUrl)
                          setMessage(`Invite copied: ${inviteUrl.slice(0, 50)}...`)
                        } catch {
                          navigator.clipboard.writeText(inviteUrl)
                        }
                      }}
                      title="Copy employee invite link"
                    >
                      📧 Invite
                    </button>
                    <button type="button" className="ghost danger" onClick={() => removeEmployee(item)}>Remove</button>
                  </div>
                </article>
              ))}
              {!directoryRows.length && <section className="card"><p className="muted">No employees found.</p></section>}
            </section>
          </>
        )}

        {section === 'roles' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Role Management</p>
                <h1>Configure Roles and Rates</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Define employee roles with pay types and rates. Rates are used for salary calculations.
                </p>
              </div>
            </section>

            <section className="card">
              <div className="row between wrap" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>{editingRoleId ? 'Edit Role' : 'Add Role'}</h3>
                  <p className="muted" style={{ margin: 0 }}>Create or update roles with their pay configurations.</p>
                </div>
                {editingRoleId ? (
                  <button type="button" className="ghost btn-sm" onClick={() => setEditingRoleId('')}>Cancel edit</button>
                ) : null}
              </div>

              <form className="employee-form" onSubmit={async (e) => {
                e.preventDefault()
                setSavingRole(true)
                setError('')
                setMessage('')
                try {
                  const roleData = {
                    roleName: newRoleName,
                    payType: newRolePayType,
                    rate: Number(newRoleRate),
                  }
                  if (editingRoleId) {
                    await updateRole(editingRoleId, roleData, user.uid)
                    setMessage('Role updated.')
                  } else {
                    await createRole(roleData, user.uid)
                    setMessage('Role added.')
                  }
                  setNewRoleName('')
                  setNewRolePayType('DAILY')
                  setNewRoleRate('')
                  setEditingRoleId('')
                  await loadRoles()
                } catch (err) {
                  setError(err.message)
                } finally {
                  setSavingRole(false)
                }
              }}>
                <div className="employee-form-grid">
                  <label>Role Name<input value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} required /></label>
                  <label>Pay Type
                    <select value={newRolePayType} onChange={(e) => setNewRolePayType(e.target.value)}>
                      <option value="DAILY">Daily</option>
                      <option value="MONTHLY">Monthly</option>
                    </select>
                  </label>
                  <label>Rate
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={newRoleRate}
                      onChange={(e) => setNewRoleRate(e.target.value)}
                      placeholder="e.g. 13000"
                      required
                    />
                  </label>
                  <div className="employee-form-actions">
                    <button type="submit" disabled={savingRole}>
                      {savingRole ? 'Saving...' : editingRoleId ? 'Save Role' : 'Add Role'}
                    </button>
                  </div>
                </div>
              </form>
            </section>

            <section className="card">
              <h3>Existing Roles</h3>
              <div className="table-wrap admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Role Name</th>
                      <th>Pay Type</th>
                      <th>Rate</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roles.map((role) => (
                      <tr key={role.id || role.roleName}>
                        <td>{role.roleName}</td>
                        <td>{role.payType}</td>
                        <td>{Number(role.rate || 0).toLocaleString()}</td>
                        <td>
                          <button className="ghost btn-sm" onClick={() => {
                            setEditingRoleId(role.id)
                            setNewRoleName(role.roleName)
                            setNewRolePayType(role.payType)
                            setNewRoleRate(String(role.rate))
                          }}>Edit</button>
                          <button className="ghost btn-sm danger" onClick={async () => {
                            if (window.confirm('Delete this role?')) {
                              try {
                                await deleteRole(role.id)
                                setMessage('Role deleted.')
                                await loadRoles()
                              } catch (err) {
                                setError(err.message)
                              }
                            }
                          }}>Delete</button>
                        </td>
                      </tr>
                    ))}
                    {!roles.length && (
                      <tr><td colSpan={4} className="muted">No roles defined yet.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {section === 'salary' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Salary Management</p>
                <h1>Attendance-driven payroll</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Generate monthly salary records from attendance and share salary visibility with employees.
                </p>
              </div>
              <div className="row gap wrap">
                <label style={{ minWidth: 190 }}>
                  <span className="muted" style={{ display: 'block', marginBottom: 6 }}>Month</span>
                  <input
                    type="month"
                    value={salaryMonth}
                    onChange={(e) => {
                      setSalaryMonth(e.target.value)
                      setSalarySelectedUserId('')
                      setSalarySelectedDateKey('')
                    }}
                  />
                </label>
                <div className="segmented" role="tablist">
                  <button type="button" className={salaryView === 'monthly' ? 'active' : ''} onClick={() => setSalaryView('monthly')}>
                    Monthly
                  </button>
                  <button type="button" className={salaryView === 'daily' ? 'active' : ''} onClick={() => setSalaryView('daily')}>
                    Daily Payments
                  </button>
                </div>
                {salaryView === 'daily' && (
                  <label style={{ minWidth: 190 }}>
                    <span className="muted" style={{ display: 'block', marginBottom: 6 }}>Date</span>
                    <input type="date" value={dailySalaryDate} onChange={(e) => setDailySalaryDate(e.target.value)} />
                  </label>
                )}
                <button type="button" onClick={generateSalary} disabled={salaryGenerating}>
                  {salaryGenerating ? 'Generating...' : 'Regenerate Month'}
                </button>
                <button type="button" className="ghost" onClick={exportSalaryCsv} disabled={!filteredSalaryRows.length}>
                  Export CSV
                </button>
                {salaryView === 'daily' && (
                  <button type="button" className="ghost" onClick={exportDailyCsv} disabled={!filteredDailyPayments.length}>
                    Export Daily CSV
                  </button>
                )}
                {salaryView === 'daily' && (
                  <button type="button" onClick={() => openDailyPaymentModal()} disabled={!employees.length}>
                    Add Daily Payment
                  </button>
                )}
              </div>
            </section>

            <section className="stats-grid">
              <article className="card stat-card">
                <h3>{salaryStats.count}</h3>
                <p>Employees</p>
              </article>
              <article className="card stat-card">
                <h3>{salaryStats.totalPayroll.toLocaleString()}</h3>
                <p>Total payroll</p>
              </article>
              <article className="card stat-card danger">
                <h3>{salaryStats.totalDeductions.toLocaleString()}</h3>
                <p>Deductions</p>
              </article>
              <article className="card stat-card">
                <h3>{salaryStats.totalBonus.toLocaleString()}</h3>
                <p>Bonus</p>
              </article>
              {salaryView === 'daily' && (
                <>
                  <article className="card stat-card">
                    <h3>{filteredDailyPayments.length}</h3>
                    <p>Daily records</p>
                  </article>
                  <article className="card stat-card">
                    <h3>{Object.values(aggregateDailyPayments(filteredDailyPayments)).reduce((sum, agg) => sum + agg.totalNetPay, 0).toLocaleString()}</h3>
                    <p>Daily net total</p>
                  </article>
                </>
              )}
            </section>

            <section className="card">
              <div className="row between wrap" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>{salaryView === 'monthly' ? 'Monthly Salary Records' : 'Daily Payments'}</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    {salaryLoading ? 'Loading...' : `${salaryView === 'monthly' ? filteredSalaryRows.length : filteredDailyPayments.length} record${(salaryView === 'monthly' ? filteredSalaryRows.length : filteredDailyPayments.length) === 1 ? '' : 's'} for ${salaryMonth}`}
                  </p>
                </div>
                <div className="row gap wrap" style={{ minWidth: 320 }}>
                  <input
                    value={salaryView === 'monthly' ? salarySearch : dailySalarySearch}
                    onChange={(e) => salaryView === 'monthly' ? setSalarySearch(e.target.value) : setDailySalarySearch(e.target.value)}
                    placeholder="Search name / uid"
                  />
                  <button type="button" className="ghost btn-sm" onClick={salaryView === 'monthly' ? loadSalary : loadDailyPayments} disabled={salaryLoading}>
                    Refresh
                  </button>
                </div>
              </div>

              <div className="table-wrap admin-table-wrap">
{salaryView === 'monthly' ? (
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>UID</th>
                        <th>Rate</th>
                        <th>Present</th>
                        <th>Late</th>
                        <th>Manual Days</th>
                        <th>OT Hrs</th>
                        <th>OT Pay</th>
                        <th>Base</th>
                        <th>Deductions</th>
                        <th>Bonus</th>
                        <th>Final</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSalaryRows.map((row) => (
                        <tr
                          key={row.id || `${row.userId}_${row.month}`}
                          onClick={() => setSalarySelectedUserId(row.userId)}
                          style={{ cursor: 'pointer' }}
                          title="Click to view details"
                        >
                          <td>{row.employeeName}</td>
                          <td><code>{row.userId}</code></td>
                          <td>{Number(row.dailyRate || 0).toLocaleString()}</td>
                          <td>{row.daysPresent}</td>
                          <td>{row.lateDays}</td>
                          <td>{row.manualCount}</td>
                          <td>{Number(row.overtimeHours || 0).toLocaleString()}</td>
                          <td>{Number(row.overtimePay || 0).toLocaleString()}</td>
                          <td>{Number(row.baseSalary || 0).toLocaleString()}</td>
                          <td>{Number(row.deductions || 0).toLocaleString()}</td>
                          <td>{Number(row.bonus || 0).toLocaleString()}</td>
                          <td><strong>{Number(row.finalSalary || 0).toLocaleString()}</strong></td>
                        </tr>
                      ))}
                      {!filteredSalaryRows.length && (
                        <tr><td colSpan={12} className="muted">No salary records yet. Click “Regenerate Month”.</td></tr>
                      )}
                    </tbody>
                  </table>
                ) : (
                  <table className="admin-table">
                    <thead>
                        <tr>
                          <th>Date</th>
                          <th>Employee</th>
                          <th>UID</th>
                          <th>Daily Salary</th>
                          <th>OT Hrs</th>
                          <th>OT Pay</th>
                          <th>Deductions</th>
                          <th>Net Pay</th>
                          <th>Notes</th>
                          <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDailyPayments.map((row) => (
                        <tr key={row.id || `${row.userId}_${row.date}`}>
                          <td>{row.date}</td>
                          <td>{row.employeeName}</td>
                          <td><code>{row.userId}</code></td>
                          <td>{Number(row.dailySalary || 0).toLocaleString()}</td>
                          <td>{Number(row.overtimeHours || 0).toLocaleString()}</td>
                          <td>{Number(row.overtimePay || 0).toLocaleString()}</td>
                          <td>{Number(row.totalDeductions || 0).toLocaleString()}</td>
                          <td><strong>{Number(row.netPay || 0).toLocaleString()}</strong></td>
                          <td>{row.notes}</td>
                          <td>
                            <button className="ghost btn-sm" onClick={() => openDailyPaymentModal(row)}>Edit</button>
                            <button className="ghost btn-sm danger" onClick={async () => {
                              if (window.confirm('Delete this daily payment?')) {
                                await deleteDailyPayment(row.id)
                                await loadDailyPayments()
                                setMessage('Daily payment deleted.')
                              }
                            }}>Delete</button>
                          </td>
                        </tr>
                      ))}
                      {!filteredDailyPayments.length && (
                        <tr><td colSpan={10} className="muted">No daily payments. Click “Add Daily Payment”.</td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </section>

            {salaryView === 'monthly' && salarySelectedUserId ? (
              <section className="card">
                {(() => {
                  const selected = salarySelectedEmployee
                  if (!selected) return <p className="muted">No record selected.</p>
                  if (salaryDetailLoading) return <p className="muted">Loading attendance details...</p>
                  return (
                    <>
                      <div className="row between wrap">
                        <div>
                          <p className="eyebrow">Salary Breakdown</p>
                          <h2 style={{ marginBottom: 4 }}>{selected.employeeName}</h2>
                          <p className="muted" style={{ margin: 0 }}>{selected.month} • UID {selected.userId}</p>
                        </div>
                        <div className="inline-pills">
                          <span className="pill neutral">Rate {Number(selected.dailyRate || 0).toLocaleString()}</span>
                          <span className="pill neutral">Expected {selected.expectedWorkDays}</span>
                          <span className="pill ok">Final {Number(selected.finalSalary || 0).toLocaleString()}</span>
                          <button type="button" className="ghost btn-sm" onClick={() => printPayslip(selected)}>
                            Print / PDF Payslip
                          </button>
                        </div>
                      </div>

                      <section className="grid two" style={{ marginTop: 12 }}>
                        <article className="card" style={{ background: 'var(--paper2)' }}>
                          <h3>Attendance</h3>
                          <div className="grid two compact">
                            <p><strong>Present:</strong> {selected.daysPresent}</p>
                            <p><strong>Absent:</strong> {selected.daysAbsent}</p>
                            <p><strong>Paid leave:</strong> {selected.paidLeave}</p>
                            <p><strong>Unpaid leave:</strong> {selected.unpaidLeave}</p>
                            <p><strong>Late days:</strong> {selected.lateDays}</p>
                            <p><strong>Checked out:</strong> {salarySelectedAttendanceSummary.checkedOut}</p>
                            <p><strong>OT days:</strong> {salarySelectedAttendanceSummary.overtime}</p>
                            <p><strong>OT mins:</strong> {salarySelectedAttendanceSummary.totalOvertimeMinutes}</p>
                          </div>
                        </article>
                        <article className="card" style={{ background: 'var(--paper2)' }}>
                          <h3>Payroll</h3>
                          <div className="grid two compact">
                            <p><strong>Attendance Base:</strong> {Number(selected.attendanceBase || 0).toLocaleString()}</p>
                            <p><strong>Manual Salary:</strong> {Number(selected.manualSalary || 0).toLocaleString()}</p>
                            <p><strong>OT Hours:</strong> {Number(selected.overtimeHours || 0).toLocaleString()}</p>
                            <p><strong>OT Pay:</strong> {Number(selected.overtimePay || 0).toLocaleString()}</p>
                            <p><strong>Total Base:</strong> {Number(selected.baseSalary || 0).toLocaleString()}</p>
                            <p><strong>Unpaid Ded:</strong> {Number(selected.attendanceUnpaidDed || 0).toLocaleString()}</p>
                            <p><strong>Late Ded:</strong> {Number(selected.lateDeduction || 0).toLocaleString()}</p>
                            <p><strong>Manual Ded:</strong> {Number(selected.manualDeductions || 0).toLocaleString()}</p>
                            <p><strong>Total Ded:</strong> {Number(selected.deductions || 0).toLocaleString()}</p>
                            <p><strong>Bonus:</strong> {Number(selected.bonus || 0).toLocaleString()}</p>
                            <p><strong>Final:</strong> {Number(selected.finalSalary || 0).toLocaleString()}</p>
                          </div>
                        </article>
                      </section>

                      <section className="salary-selected-summary">
                        <article className="card salary-calendar-card">
                          <div className="row between wrap" style={{ marginBottom: 8 }}>
                            <div>
                              <h3 style={{ marginBottom: 4 }}>Attendance Calendar</h3>
                              <p className="muted" style={{ margin: 0 }}>Click a day to inspect in/out times, overtime, and shift status.</p>
                            </div>
                            <span className="pill neutral">{salaryMonth}</span>
                          </div>
                          <div className="calendar-grid">
                            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                              <span key={day} className="calendar-weekday">{day}</span>
                            ))}
                            {Array.from({ length: (((new Date(Date.UTC(Number(String(salaryMonth).slice(0, 4)), Number(String(salaryMonth).slice(5, 7)) - 1, 1, 12, 0, 0, 0)).getUTCDay() + 6) % 7) + new Date(Date.UTC(Number(String(salaryMonth).slice(0, 4)), Number(String(salaryMonth).slice(5, 7)), 0)).getUTCDate()) }, (_, index) => {
                              const year = Number(String(salaryMonth).slice(0, 4))
                              const monthIndex = Number(String(salaryMonth).slice(5, 7)) - 1
                              const firstDay = new Date(Date.UTC(year, monthIndex, 1, 12, 0, 0, 0))
                              const startOffset = (firstDay.getUTCDay() + 6) % 7
                              const day = index < startOffset ? null : index - startOffset + 1
                              if (!day) {
                                return <div key={`empty-${index}`} className="calendar-cell empty" />
                              }
                              const dayKey = `${salaryMonth}-${String(day).padStart(2, '0')}`
                              const row = salarySelectedAttendanceMap.get(dayKey) || null
                              const status = row
                                ? row.checkInAt
                                  ? row.checkOutAt
                                    ? 'present'
                                    : 'open'
                                  : 'absent'
                                : 'absent'
                              const isSelected = (salarySelectedDateKey || `${salaryMonth}-01`) === dayKey
                              const overtimeHours = Math.round((Number(row?.overtimeMinutes || 0) / 60) * 100) / 100
                              return (
                                <button
                                  key={dayKey}
                                  type="button"
                                  className={`calendar-cell ${status} ${isSelected ? 'selected' : ''}`}
                                  onClick={() => setSalarySelectedDateKey(dayKey)}
                                >
                                  <span className="calendar-day">{day}</span>
                                  <span className="calendar-status">{row ? (row.checkInAt ? 'Present' : 'Absent') : 'Absent'}</span>
                                  <span className="calendar-time">{row?.checkInAt ? formatClock(row.checkInAt) : 'No check-in'}</span>
                                  <span className="calendar-overtime">{overtimeHours > 0 ? `${overtimeHours}h OT` : status === 'absent' ? 'Missing' : 'No OT'}</span>
                                </button>
                              )
                            })}
                          </div>
                        </article>

                        <article className="card salary-day-detail">
                          <h3 style={{ marginBottom: 6 }}>Selected Day</h3>
                          <p className="muted" style={{ marginTop: 0 }}>
                            {(salarySelectedDateKey || `${salaryMonth}-01`)} • {salarySelectedAttendanceMap.get(salarySelectedDateKey || `${salaryMonth}-01`)?.checkInAt ? 'Present' : 'Absent'}
                          </p>
                          {(() => {
                            const row = salarySelectedAttendanceMap.get(salarySelectedDateKey || `${salaryMonth}-01`) || null
                            return (
                              <>
                                <div className="grid two compact salary-day-grid">
                                  <p><strong>Check In:</strong> {row?.checkInAt ? formatClock(row.checkInAt) : '-'}</p>
                                  <p><strong>Check Out:</strong> {row?.checkOutAt ? formatClock(row.checkOutAt) : '-'}</p>
                                  <p><strong>Worked:</strong> {formatDurationMs(Number(row?.workedMinutes || 0) * 60000)}</p>
                                  <p><strong>OT:</strong> {Math.round((Number(row?.overtimeMinutes || 0) / 60) * 100) / 100}h</p>
                                  <p><strong>OT Pay:</strong> {Number(row?.overtimePay || 0).toLocaleString()}</p>
                                  <p><strong>Season:</strong> {row?.overtimeLabel || '-'}</p>
                                </div>
                                <p className="salary-day-note muted">
                                  {row?.checkInAt
                                    ? row?.checkOutAt
                                      ? 'This day is closed and payroll-ready.'
                                      : 'Employee checked in but has not checked out yet.'
                                    : 'No attendance record was found for this date.'}
                                </p>
                              </>
                            )
                          })()}
                        </article>
                      </section>
                    </>
                  )
                })()}
              </section>
            ) : null}
            {showDailyModal && (
              <section className="card modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowDailyModal(false)}>
                <article className="card modal">
                  <div className="row between">
                    <h3>{dailyModalEmployee ? `Edit Payment for ${dailyModalEmployee.name}` : 'Add Daily Payment'}</h3>
                    <button type="button" className="close" onClick={() => setShowDailyModal(false)}>×</button>
                  </div>
                  <form onSubmit={async (e) => {
                    e.preventDefault()
                    setSavingDaily(true)
                    try {
                      if (!dailyModalEmployee?.id) {
                        throw new Error('Employee is required for daily payment.')
                      }
                      const docId = dailyModalEmployee.docId || `${dailyModalEmployee.id}_${dailySalaryDate}`
                      const payload = {
                        userId: dailyModalEmployee.id,
                        date: dailySalaryDate,
                        employeeName: dailyModalEmployee.name,
                        dailySalary: Number(dailyModalData.dailySalary),
                        deductions: dailyModalData.deductions,
                        notes: dailyModalData.notes
                      }
                      if (dailyModalEmployee.docId) {
                        await updateDailyPayment(docId, payload, user.uid)
                        setMessage('Daily payment updated.')
                      } else {
                        await createDailyPayment(payload, user.uid)
                        setMessage('Daily payment added.')
                      }
                      setShowDailyModal(false)
                      await loadDailyPayments()
                    } catch (err) {
                      setError(err.message)
                    } finally {
                      setSavingDaily(false)
                    }
                  }}>
                    <div className="stack">
                      <label>Employee
                        <select
                          value={dailyModalEmployee?.id || ''}
                          onChange={(e) => {
                            const selectedId = e.target.value
                            const employee = employees.find((emp) => (emp.id || emp.userId) === selectedId)
                            setDailyModalEmployee((current) => ({
                              id: selectedId,
                              name: employee ? (employee.name || employee.email || selectedId) : '',
                              docId: current?.id === selectedId ? current?.docId : undefined,
                              date: current?.date || dailySalaryDate,
                            }))
                          }}
                          required
                        >
                          <option value="">Select employee</option>
                          {employees.map((emp) => (
                            <option key={emp.id || emp.userId} value={emp.id || emp.userId}>
                              {emp.name || emp.email || emp.id || emp.userId}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>Daily Salary
                        <input type="number" step="any" min="0" value={dailyModalData.dailySalary} onChange={(e) => setDailyModalData({...dailyModalData, dailySalary: e.target.value})} />
                      </label>
                      <div>
                        <h4>Deductions</h4>
                        {['advance', 'fine', 'loan', 'other'].map(type => (
                          <label key={type} style={{display: 'block'}}>
                            {type.charAt(0).toUpperCase() + type.slice(1)} 
                            <input type="number" step="any" min="0" value={dailyModalData.deductions[type]} onChange={(e) => setDailyModalData({
                              ...dailyModalData,
                              deductions: {...dailyModalData.deductions, [type]: Number(e.target.value)}
                            })} />
                          </label>
                        ))}
                      </div>
                      <label>Notes
                        <input value={dailyModalData.notes} onChange={(e) => setDailyModalData({...dailyModalData, notes: e.target.value})} />
                      </label>
                      <div className="row gap">
                        <button type="submit" disabled={savingDaily}>
                          {savingDaily ? 'Saving...' : dailyModalEmployee ? 'Update' : 'Add'}
                        </button>
                        <button type="button" className="ghost" onClick={() => setShowDailyModal(false)}>Cancel</button>
                      </div>
                    </div>
                  </form>
                </article>
              </section>
            )}
          </>
        )}

        {section === 'qrcodes' && (
          <>
            {/* Loading/Empty States */}
            {loading ? (
              <section className="card">
                <div style={{padding: '80px 20px', textAlign: 'center'}}>
                  <div style={{fontSize: '48px', marginBottom: '20px'}}>⏳</div>
                  <h3>Loading Tokens...</h3>
                  <p className="muted">Fetching token history</p>
                </div>
              </section>
            ) : tokenHistory.length === 0 ? (
              <section className="card empty-state" style={{textAlign: 'center', padding: '80px 40px'}}>
                <div style={{fontSize: '64px', marginBottom: '24px'}}>🎫</div>
                <h2>No Tokens Yet</h2>
                <p className="muted" style={{maxWidth: '400px', margin: '0 auto 24px'}}>
                  Generate your first QR token for the TV attendance screen
                </p>
                <button onClick={regenerateToken} className="primary" style={{fontSize: '18px', padding: '12px 32px'}}>
                  Create First Token
                </button>
              </section>
            ) : (
              <>
                <section className="card admin-top-row">
                  <div>
                    <p className="eyebrow">QR Management</p>
                    <h1>Token Dashboard</h1>
                    <p className="muted">
                      {tokenHistory.filter(t => t.active).length} active •{' '}
                      {tokenHistory.reduce((sum, t) => sum + (t.scansCount || 0), 0)} total scans •{' '}
                      Last updated {formatRelative(tokenHistory[0]?.issuedAt)}
                    </p>
                  </div>
                  <div className="row gap">
                    <button onClick={regenerateToken}>New Token</button>
                    <button className="ghost" onClick={launchTvDisplay}>Copy TV Link</button>
                    <button className="ghost" onClick={() => downloadCsv(`tokens-${getTodayKey()}.csv`, tokenHistory.map(t => ({
                      Token: t.token, 
                      Status: t.active?'Active':'Expired',
                      Scans: t.scansCount||0,
                      Issued: t.issuedAt, 
                      Expires: t.expiresAt
                    })))}>Export CSV</button>
                    {tokenHistory.filter(t => !t.active).length > 0 && (
                      <button className="ghost danger" onClick={handleBulkDeleteExpired}>
                        Clean Expired ({tokenHistory.filter(t => !t.active).length})
                      </button>
                    )}
                  </div>
                </section>

                <section className="card">
                  <div className="row between wrap" style={{ gap: 16 }}>
                    <div>
                      <h3 style={{ marginBottom: 4 }}>QR Refresh Interval</h3>
                      <p className="muted" style={{ margin: 0 }}>Tokens now refresh no faster than once per minute.</p>
                    </div>
                    <div className="row gap wrap">
                      {QR_REFRESH_OPTIONS.map((interval) => (
                        <button
                          key={interval}
                          type="button"
                          className={`pill ${Number(settings.refreshInterval) === interval ? 'ok' : 'neutral'}`}
                          onClick={() => setSettings((old) => ({ ...old, refreshInterval: interval }))}
                          style={{ minWidth: 84 }}
                        >
                          {interval === 60 ? '1m' : interval === 300 ? '5m' : interval === 3600 ? '1h' : 'Daily'}
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                {/* Active Token Hero */}
                <section className="card">
                  <div className="qr-hero">
                    <div className="row between wrap">
                      <div>
                        <h3 style={{marginBottom: '4px'}}>Active Token</h3>
                        <span className={`pill ${activeToken?.active ? 'ok' : 'warning'}`}>
                          {activeToken?.active 
                            ? `Active • ${Math.max(0, Math.floor((activeToken.expiresAtMs - Date.now()) / 1000 / 60))}m remaining`
                            : 'No active token'}
                        </span>
                      </div>
                      <div style={{fontFamily: 'monospace', fontSize: '14px'}}>
                        Scans Today: {tokenHistory.filter(t => t.scansCount > 0).length}
                      </div>
                    </div>
                    {activeToken?.token ? (
                      <div style={{textAlign: 'center', margin: '32px 0'}}>
                        <img 
                          src={buildQrUrl(activeToken.token)} 
                          alt="Active QR Token" 
                          className="qr-large" 
                          style={{maxWidth: '280px', borderRadius: '16px'}}
                        />
                        <div style={{marginTop: '16px'}}>
                          <code style={{fontSize: '20px', letterSpacing: '2px', background: 'var(--paper2)', padding: '12px 20px', borderRadius: '8px', display: 'inline-block'}}>
                            {activeToken.token}
                          </code>
                        </div>
                        <div className="row gap" style={{justifyContent: 'center', marginTop: '16px'}}>
                          <button className="ghost" onClick={copyToken}>Copy</button>
                          <button className="ghost" onClick={() => {
                            const a = document.createElement('a')
                            a.href = buildQrUrl(activeToken.token)
                            a.download = `scantrack-qr-${activeToken.token}.png`
                            a.click()
                          }}>Download PNG</button>
                        </div>
                      </div>
                    ) : (
                      <div style={{padding: '60px 20px', textAlign: 'center'}}>
                        <p className="muted" style={{fontSize: '18px'}}>
                          <button onClick={regenerateToken} className="ghost" style={{fontSize: '18px'}}>Generate Active Token</button>
                        </p>
                      </div>
                    )}
                  </div>
                </section>

                {/* Token Search & Filter */}
                <section className="card">
                  <div className="row gap" style={{alignItems: 'end'}}>
                    <label style={{flex: 1}}>
                      <strong>Search Tokens</strong>
                      <input 
                        value={tokenSearch}
                        onChange={(e) => setTokenSearch(e.target.value)}
                        placeholder="Filter by token, scans, status..." 
                      />
                    </label>
                    <label>
                      <strong>Status</strong>
                      <select value={tokenStatusFilter} onChange={(e) => setTokenStatusFilter(e.target.value)}>
                        <option value="all">All Tokens</option>
                        <option value="active">Active Only</option>
                        <option value="expired">Expired</option>
                      </select>
                    </label>
                  </div>
                </section>

                {/* Token History Table */}
                <section className="card">
                  <h3>Token History <span className="muted" style={{fontSize: '14px'}}>({filteredTokens.length})</span></h3>
                  <div className="table-wrap">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th style={{width: '160px'}}>Token ID</th>
                          <th>Status</th>
                          <th>Scans</th>
                          <th>Issued</th>
                          <th>Expires</th>
                          <th style={{width: '120px'}}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTokens.map((token, idx) => (
                          <tr key={token.id || idx}>
                            <td><code>{token.token.slice(0,12)}...</code></td>
                            <td>
                              <span className={`pill ${token.active ? 'ok' : 'danger'}`}>
                                {token.active ? 'Active' : 'Expired'}
                              </span>
                            </td>
                            <td><strong>{token.scansCount || 0}</strong></td>
                            <td>{formatClock(token.issuedAt)}</td>
                            <td>{formatRelative(token.expiresAt)}</td>
                            <td>
                              <div className="row gap">
                                <button className="ghost btn-sm" onClick={() => handleCopyToken(token.token)}>Copy</button>
                                {token.active ? (
                                  <button className="ghost btn-sm warning" onClick={() => handleRevokeToken(token.token)}>Revoke</button>
                                ) : (
                                  <button className="ghost btn-sm danger" onClick={() => handleDeleteToken(token.token)}>Delete</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                {/* Validation Alerts */}
                {tokenValidations.length > 0 && (
                  <section className="card">
                    <h3>⚠️ System Alerts</h3>
                    <div className="validation-alerts">
                      {tokenValidations.map((warning, idx) => (
                        <article key={idx} className={`validation-alert ${warning.severity}`}>
                          <div className="validation-alert-content">
                            <strong>{warning.type === 'rotation' ? 'Security' : warning.type === 'multi-active' ? 'Configuration' : 'Connectivity'}</strong>
                            <p>{warning.message}</p>
                          </div>
                          <div className="validation-alert-actions">
                            {warning.type === 'rotation' && (
                              <button className="ghost btn-sm" onClick={regenerateToken}>Rotate Token</button>
                            )}
                            {warning.type === 'multi-active' && (
                              <button className="ghost btn-sm" onClick={() => setTokenStatusFilter('active')}>View Active</button>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}

                {/* Attendance Range Export */}
                <section className="card">
                  <div className="row between wrap" style={{ gap: 16 }}>
                    <div>
                      <h3 style={{ marginBottom: 4 }}>Attendance Export</h3>
                      <p className="muted" style={{ margin: 0 }}>Export attendance logs for reports and audits.</p>
                    </div>
                    <div className="row gap wrap">
                      <label>
                        <span className="muted">From</span>
                        <input 
                          type="date" 
                          value={attendanceRangeStart} 
                          onChange={(e) => setAttendanceRangeStart(e.target.value)} 
                        />
                      </label>
                      <label>
                        <span className="muted">To</span>
                        <input 
                          type="date" 
                          value={attendanceRangeEnd} 
                          onChange={(e) => setAttendanceRangeEnd(e.target.value)} 
                        />
                      </label>
                      <button 
                        className="ghost" 
                        onClick={exportAttendanceRange}
                        disabled={attendanceRangeLoading || !attendanceRangeData.length}
                      >
                        {attendanceRangeLoading ? 'Loading...' : `Export CSV (${attendanceRangeData.length})`}
                      </button>
                    </div>
                  </div>
                </section>

                {/* Analytics Dashboard */}
                <section className="grid two gap">
                  <section className="card">
                    <h3>Scan Activity (Last 7 Days)</h3>
                    {tokenStatsLoading ? (
                      <div className="mini-chart-loading muted">Loading activity data...</div>
                    ) : tokenStats?.byHour?.length > 0 ? (
                      <div className="mini-chart">
                        {tokenStats.byHour.slice(-24).map((hour, i) => (
                          <div key={i} className="mini-col">
                            <div className="mini-stack" style={{height: '140px'}}>
                              <div className="mini-seg ok" 
                                   style={{height: `${Math.min(140, (hour.count / Math.max(1, tokenStats.peakHour?.count || 1)) * 140)}px`}} 
                                   title={`${hour.count} scans at ${hour.hour.slice(-5)}`} />
                            </div>
                            <span style={{fontSize: '10px'}}>{new Date(hour.hour).toLocaleTimeString('en-US', {hour: '2-digit', hour12: false})}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mini-chart-empty muted">No scan data available</div>
                    )}
                  </section>
                  <section className="card">
                    <h3>Performance Metrics</h3>
                    <div className="stats-grid three">
                      <article className="stat-card ok">
                        <h3>{tokenHistory.filter(t => t.active).length}</h3>
                        <p>Active Tokens</p>
                      </article>
                      <article className="stat-card">
                        <h3>{tokenStats?.avgPerHour ? Math.round(tokenStats.avgPerHour * 10) / 10 : 0}</h3>
                        <p>Avg Scans/Hour</p>
                      </article>
                      <article className="stat-card">
                        <h3>{tokenStats?.peakHour ? tokenStats.peakHour.count : 0}</h3>
                        <p>Peak Hour</p>
                      </article>
                      <article className="stat-card danger">
                        <h3>{tokenHistory.filter(t => !t.active).length}</h3>
                        <p>Expired Tokens</p>
                      </article>
                      <article className="stat-card">
                        <h3>{tokenHistory.reduce((sum,t)=>sum+(t.scansCount||0),0)}</h3>
                        <p>Total Scans</p>
                      </article>
                      <article className="stat-card ok">
                        <h3>{Math.round((tokenHistory.filter(t => t.active && (t.scansCount || 0) > 0).length / Math.max(1, tokenHistory.filter(t => t.active).length)) * 100)}%</h3>
                        <p>Active Usage</p>
                      </article>
                    </div>
                  </section>
                </section>
              </>
            )}
          </>  
        )}
        {section === 'alerts' && (
          <>
            <section className="card admin-top-row">
              <div>
                <p className="eyebrow">Late Alerts</p>
                <h1>Auto-generated notifications</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>Review late arrivals, acknowledge, export, and take action.</p>
              </div>
              <div className="row gap wrap">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setSection('attendance')
                    setAttendanceView('logs')
                    setStatusFilter('late')
                    setAttendancePage(1)
                  }}
                  disabled={!alertsStats.onDateTotal}
                >
                  View late logs
                </button>
                <button className="ghost" onClick={() => downloadCsv(`late-alerts-${date}.csv`, filteredAlerts.map((a) => ({
                  Date: a.date || date,
                  Employee: a.employeeName || '-',
                  UID: a.userId || '-',
                  'Check In': a.clientTs || '-',
                  'Late (mins)': calcLateMinutes(a, alertsStats.schedule) ?? '-',
                  GPS: a.gps ? `${a.gps.lat},${a.gps.lng}` : '-',
                  Token: a.token || '-',
                })))} disabled={!filteredAlerts.length}>Export CSV</button>
                <button className="ghost danger" onClick={clearAlerts} disabled={!alertsStats.onDateTotal}>Clear date</button>
                <button className="ghost danger" onClick={clearAllAlerts} disabled={!alertsStats.onDateTotal}>Clear all</button>
              </div>
            </section>

            <section className="card alerts-toolbar">
              <div className="grid filters wide">
                <label>Date<input type="date" value={date} onChange={(e) => { setDateTouched(true); setDate(e.target.value) }} /></label>
                <label>Search<input value={alertsSearch} onChange={(e) => setAlertsSearch(e.target.value)} placeholder="Search name / id / token" /></label>
                <label className="toggle-inline">
                  <span>Hide acknowledged</span>
                  <input type="checkbox" checked={alertsHideAcknowledged} onChange={(e) => setAlertsHideAcknowledged(e.target.checked)} />
                </label>
                <label className="toggle-inline">
                  <span>Group by employee</span>
                  <input type="checkbox" checked={alertsGroupByEmployee} onChange={(e) => setAlertsGroupByEmployee(e.target.checked)} />
                </label>
              </div>
            </section>

            <section className="stats-grid six">
              <article className="card stat-card danger">
                <h3>{alertsStats.onDateTotal}</h3>
                <p>Late alerts (date)</p>
              </article>
              <article className="card stat-card">
                <h3>{alertsStats.total}</h3>
                <p>Visible alerts</p>
              </article>
              <article className="card stat-card">
                <h3>{alertsStats.unique}</h3>
                <p>Employees</p>
              </article>
              <article className="card stat-card">
                <h3>{alertsStats.avgLateMins}m</h3>
                <p>Avg late</p>
              </article>
              <article className="card stat-card danger">
                <h3>{alertsStats.worstLateMins}m</h3>
                <p>Worst late</p>
              </article>
              <article className="card stat-card">
                <h3>{alertsStats.schedule.enabled ? 'Open' : 'Closed'}</h3>
                <p>{alertsStats.schedule.workStart}–{alertsStats.schedule.workEnd}</p>
              </article>
            </section>

            <section className="alerts-list">
              {!alertsStats.onDateTotal ? (
                <section className="card empty-state">
                  <div className="empty-icon">✓</div>
                  <div>
                    <h3 style={{ marginBottom: 6 }}>No late alerts</h3>
                    <p className="muted" style={{ margin: 0 }}>This date has no late arrivals. You can still review attendance logs.</p>
                    <div className="row gap wrap" style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setSection('attendance')
                          setAttendanceView('logs')
                          setStatusFilter('all')
                          setAttendancePage(1)
                        }}
                      >
                        Open attendance
                      </button>
                      <button type="button" className="ghost" onClick={() => setSection('settings')}>Check schedule</button>
                    </div>
                  </div>
                </section>
              ) : alertsGroupByEmployee ? (
                groupedAlerts.map((group) => {
                  const first = group.items[0]
                  const schedule = getScheduleForDate(first?.date || date, settings)
                  const worst = Math.max(...group.items.map((a) => calcLateMinutes(a, schedule) || 0))
                  const acknowledged = group.items.every((a) => alertAck[a._key])
                  return (
                    <section key={group.uid || group.employeeName || first?._key} className={`card alert-group ${acknowledged ? 'ack' : ''}`}>
                      <div className="alert-group-head">
                        <div className="emp-avatar sm">{String(group.employeeName || 'E').slice(0, 2).toUpperCase()}</div>
                        <div style={{ minWidth: 0 }}>
                          <h3 style={{ marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.employeeName}</h3>
                          <p className="muted" style={{ margin: 0 }}>
                            {group.items.length} alert{group.items.length === 1 ? '' : 's'} • worst {worst}m late • {schedule.workStart} start
                          </p>
                        </div>
                        <div className="row gap wrap" style={{ justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className="ghost btn-sm"
                            onClick={() => {
                              setSelectedEmployee(group.uid)
                              setSection('attendance')
                              setAttendanceView('logs')
                              setStatusFilter('late')
                              setAttendancePage(1)
                            }}
                          >
                            View logs
                          </button>
                          <button
                            type="button"
                            className="ghost btn-sm"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(String(group.uid || ''))
                                setMessage('Employee id copied.')
                              } catch {
                                setError('Clipboard copy not available in this browser.')
                              }
                            }}
                          >
                            Copy UID
                          </button>
                          {acknowledged ? (
                            <button
                              type="button"
                              className="ghost btn-sm"
                              onClick={() => group.items.forEach((a) => unacknowledgeAlert(a._key))}
                            >
                              Unack
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="ghost btn-sm"
                              onClick={() => group.items.forEach((a) => acknowledgeAlert(a._key))}
                            >
                              Acknowledge
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="alert-sublist">
                        {group.items.slice(0, 5).map((alert) => {
                          const lateMins = calcLateMinutes(alert, schedule)
                          const mapsUrl = buildMapsUrl(alert.gps)
                          const isAck = Boolean(alertAck[alert._key])
                          return (
                            <article key={alert._key} className={`alert-row compact ${isAck ? 'ack' : ''}`}>
                              <div className="alert-icon" aria-hidden="true">!</div>
                              <div className="alert-body">
                                <div className="row between wrap">
                                  <div className="row gap wrap">
                                    <span className="pill danger">Late</span>
                                    <span className="pill neutral">{lateMins == null ? '-' : `${lateMins}m`}</span>
                                    <span className="muted">{formatClock(alert.clientTs)} ({formatRelative(alert.clientTs)})</span>
                                  </div>
                                  <div className="row gap wrap">
                                    {mapsUrl ? (
                                      <a className="ghost btn-sm" href={mapsUrl} target="_blank" rel="noreferrer">Map</a>
                                    ) : (
                                      <span className="muted">No GPS</span>
                                    )}
                                    <button
                                      type="button"
                                      className="ghost btn-sm"
                                      onClick={() => (isAck ? unacknowledgeAlert(alert._key) : acknowledgeAlert(alert._key))}
                                    >
                                      {isAck ? 'Unack' : 'Ack'}
                                    </button>
                                  </div>
                                </div>
                                <p className="muted" style={{ margin: '8px 0 0' }}>
                                  Work starts {schedule.workStart} • grace {schedule.graceMins}m • token {String(alert.token || '').slice(0, 6) || '-'}
                                </p>
                              </div>
                            </article>
                          )
                        })}
                        {group.items.length > 5 ? (
                          <p className="muted" style={{ margin: '10px 0 0' }}>+ {group.items.length - 5} more… use “View logs” for full details.</p>
                        ) : null}
                      </div>
                    </section>
                  )
                })
              ) : (
                filteredAlerts.map((alert) => {
                  const schedule = getScheduleForDate(alert.date || date, settings)
                  const alertKey = alert._key
                  const lateMins = calcLateMinutes(alert, schedule)
                  const mapsUrl = buildMapsUrl(alert.gps)
                  const isAck = Boolean(alertAck[alertKey])
                  return (
                    <article className={`card alert-row ${isAck ? 'ack' : ''}`} key={alertKey}>
                      <div className="alert-icon" aria-hidden="true">!</div>
                      <div className="alert-body">
                        <div className="row between wrap">
                          <h3 style={{ marginBottom: 0 }}>{alert.employeeName} arrived late</h3>
                          <div className="inline-pills">
                            <span className="pill danger">Late</span>
                            <span className="pill neutral">{lateMins == null ? '-' : `${lateMins}m`}</span>
                            {isAck ? <span className="pill ok">Acknowledged</span> : null}
                          </div>
                        </div>
                        <p className="muted" style={{ margin: '8px 0 0' }}>
                          Checked in at {formatClock(alert.clientTs)} ({formatRelative(alert.clientTs)}) • work starts {schedule.workStart} • grace {schedule.graceMins} min
                        </p>
                        <div className="row gap wrap" style={{ marginTop: 12 }}>
                          <button
                            type="button"
                            className="ghost btn-sm"
                            onClick={() => {
                              if (alert.date) {
                                setDateTouched(true)
                                setDate(alert.date)
                              }
                              if (alert.userId) {
                                setSelectedEmployee(alert.userId)
                              }
                              setSection('attendance')
                              setAttendanceView('logs')
                              setStatusFilter('late')
                              setAttendancePage(1)
                            }}
                          >
                            View in attendance
                          </button>
                          <button
                            type="button"
                            className="ghost btn-sm"
                            onClick={() => (isAck ? unacknowledgeAlert(alertKey) : acknowledgeAlert(alertKey))}
                          >
                            {isAck ? 'Unacknowledge' : 'Acknowledge'}
                          </button>
                          {mapsUrl ? <a className="ghost btn-sm" href={mapsUrl} target="_blank" rel="noreferrer">Open map</a> : null}
                          <button
                            type="button"
                            className="ghost btn-sm"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(String(alert.userId || ''))
                                setMessage('Employee id copied.')
                              } catch {
                                setError('Clipboard copy not available in this browser.')
                              }
                            }}
                          >
                            Copy UID
                          </button>
                        </div>
                      </div>
                    </article>
                  )
                })
              )}
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
                <h3>Default Work Hours</h3>
                <div className="stack">
                  <label>Work Start Time<input type="time" value={settings.workStart} onChange={(e) => setSettings((old) => ({ ...old, workStart: e.target.value }))} /></label>
                  <label>Work End Time<input type="time" value={settings.workEnd} onChange={(e) => setSettings((old) => ({ ...old, workEnd: e.target.value }))} /></label>
                  <label>Grace Period (minutes)<input type="number" min="0" value={settings.graceMins} onChange={(e) => setSettings((old) => ({ ...old, graceMins: Number(e.target.value) }))} /></label>
                </div>
                <p className="muted" style={{ margin: '10px 0 0' }}>
                  Used as a fallback. Weekly schedule overrides this per day.
                </p>
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
              <div className="row between wrap" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>Weekly Schedule</h3>
                  <p className="muted" style={{ margin: 0 }}>Set different work hours per day and decide if check-in / check-out is allowed.</p>
                </div>
                <div className="row gap wrap">
                  <button
                    type="button"
                    className="ghost btn-sm"
                    onClick={() => {
                      setSettings((old) => {
                        const next = { ...(old.weeklySchedule || {}) }
                        for (const { key } of WEEK) {
                          next[key] = {
                            ...(next[key] || {}),
                            enabled: true,
                            workStart: old.workStart,
                            workEnd: old.workEnd,
                            graceMins: old.graceMins,
                            allowCheckIn: true,
                            allowCheckOut: true,
                          }
                        }
                        return { ...old, weeklySchedule: next }
                      })
                      setMessage('Applied default hours to all days.')
                    }}
                  >
                    Apply defaults to all
                  </button>
                  <button
                    type="button"
                    className="ghost btn-sm"
                    onClick={() => {
                      setSettings((old) => {
                        const next = { ...(old.weeklySchedule || {}) }
                        for (const { key } of WEEK) {
                          const isWeekend = key === 'sat' || key === 'sun'
                          next[key] = { ...(next[key] || {}), enabled: !isWeekend }
                        }
                        return { ...old, weeklySchedule: next }
                      })
                      setMessage('Weekend marked as off (Sat/Sun).')
                    }}
                  >
                    Weekend off
                  </button>
                </div>
              </div>

              <div className="table-wrap schedule-table-wrap">
                <table className="admin-table schedule-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Enabled</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Grace</th>
                      <th>Check In</th>
                      <th>Check Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {WEEK.map((day) => {
                      const rule = settings.weeklySchedule?.[day.key] || {}
                      const enabled = rule.enabled !== false
                      return (
                        <tr key={day.key}>
                          <td><strong>{day.label}</strong></td>
                          <td>
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(e) =>
                                setSettings((old) => ({
                                  ...old,
                                  weeklySchedule: {
                                    ...(old.weeklySchedule || {}),
                                    [day.key]: { ...(old.weeklySchedule?.[day.key] || {}), enabled: e.target.checked },
                                  },
                                }))
                              }
                              style={{ width: 18, height: 18 }}
                              aria-label={`${day.label} enabled`}
                            />
                          </td>
                          <td>
                            <input
                              type="time"
                              value={rule.workStart || settings.workStart}
                              onChange={(e) =>
                                setSettings((old) => ({
                                  ...old,
                                  weeklySchedule: {
                                    ...(old.weeklySchedule || {}),
                                    [day.key]: { ...(old.weeklySchedule?.[day.key] || {}), workStart: e.target.value },
                                  },
                                }))
                              }
                              disabled={!enabled}
                            />
                          </td>
                          <td>
                            <input
                              type="time"
                              value={rule.workEnd || settings.workEnd}
                              onChange={(e) =>
                                setSettings((old) => ({
                                  ...old,
                                  weeklySchedule: {
                                    ...(old.weeklySchedule || {}),
                                    [day.key]: { ...(old.weeklySchedule?.[day.key] || {}), workEnd: e.target.value },
                                  },
                                }))
                              }
                              disabled={!enabled}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              value={Number(rule.graceMins ?? settings.graceMins)}
                              onChange={(e) =>
                                setSettings((old) => ({
                                  ...old,
                                  weeklySchedule: {
                                    ...(old.weeklySchedule || {}),
                                    [day.key]: { ...(old.weeklySchedule?.[day.key] || {}), graceMins: Number(e.target.value) },
                                  },
                                }))
                              }
                              disabled={!enabled}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={rule.allowCheckIn !== false}
                              onChange={(e) =>
                                setSettings((old) => ({
                                  ...old,
                                  weeklySchedule: {
                                    ...(old.weeklySchedule || {}),
                                    [day.key]: { ...(old.weeklySchedule?.[day.key] || {}), allowCheckIn: e.target.checked },
                                  },
                                }))
                              }
                              disabled={!enabled}
                              style={{ width: 18, height: 18 }}
                              aria-label={`${day.label} allow check-in`}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={rule.allowCheckOut !== false}
                              onChange={(e) =>
                                setSettings((old) => ({
                                  ...old,
                                  weeklySchedule: {
                                    ...(old.weeklySchedule || {}),
                                    [day.key]: { ...(old.weeklySchedule?.[day.key] || {}), allowCheckOut: e.target.checked },
                                  },
                                }))
                              }
                              disabled={!enabled}
                              style={{ width: 18, height: 18 }}
                              aria-label={`${day.label} allow check-out`}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="muted" style={{ margin: '10px 0 0' }}>
                Disabled days block employee scans and prevent late alerts. You can also disable only check-in or only check-out.
              </p>
            </section>

            <section className="grid two">
              <article className="card">
                <h3>Payroll Rules</h3>
                <div className="stack">
                  <label>Expected work days / month
                    <input
                      type="number"
                      min="1"
                      value={settings.payrollRules?.expectedWorkDays ?? 26}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), expectedWorkDays: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Default paid holidays (per employee)
                    <input
                      type="number"
                      min="0"
                      value={settings.payrollRules?.defaultAllowedHolidays ?? 1}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), defaultAllowedHolidays: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Late deduction (fraction of daily rate per late day)
                    <input
                      type="number"
                      min="0"
                      step="0.05"
                      value={settings.payrollRules?.latePenaltyFraction ?? 0.5}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), latePenaltyFraction: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label className="toggle-row">
                    <span>Enable overtime pay</span>
                    <input
                      type="checkbox"
                      checked={settings.payrollRules?.overtimeEnabled !== false}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), overtimeEnabled: e.target.checked },
                        }))
                      }
                    />
                  </label>
                  <label>Overtime threshold (minutes)
                    <input
                      type="number"
                      min="0"
                      value={settings.payrollRules?.overtimeThresholdMins ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), overtimeThresholdMins: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Standard overtime multiplier
                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      value={settings.payrollRules?.overtimeMultiplier ?? 1.5}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), overtimeMultiplier: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Seasonal overtime multiplier
                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      value={settings.payrollRules?.seasonalOvertimeMultiplier ?? 2}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), seasonalOvertimeMultiplier: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Season start (MM-DD)
                    <input
                      type="text"
                      placeholder="12-15"
                      value={settings.payrollRules?.seasonalOvertimeStart ?? '12-15'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), seasonalOvertimeStart: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>Season end (MM-DD)
                    <input
                      type="text"
                      placeholder="01-10"
                      value={settings.payrollRules?.seasonalOvertimeEnd ?? '01-10'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), seasonalOvertimeEnd: e.target.value },
                        }))
                      }
                    />
                  </label>
                </div>
                <p className="muted" style={{ margin: '10px 0 0' }}>
                  Example: `0.5` means each late day deducts half a day rate.
                </p>
                <p className="muted" style={{ margin: '8px 0 0' }}>
                  Overtime applies after the scheduled end time, with a seasonal rate for Christmas and New Year if configured.
                </p>
              </article>

              <article className="card">
                <h3>Bonus Rules</h3>
                <div className="stack">
                  <label>Perfect attendance bonus (fixed)
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.perfectAttendanceBonus ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), perfectAttendanceBonus: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>No late days bonus (fixed)
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.noLateBonus ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), noLateBonus: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                </div>
                <p className="muted" style={{ margin: '10px 0 0' }}>
                  Bonuses apply when salary is generated for the month.
                </p>
              </article>
            </section>

            <section className="grid two">
              <article className="card">
                <h3>Shop GPS Location</h3>
                <div className="stack">
                  <label>Latitude<input type="number" step="any" value={gpsLat} onChange={(e) => {
                    setGpsLat(Number(e.target.value))
                  }} /></label>
                  <label>Longitude<input type="number" step="any" value={gpsLng} onChange={(e) => {
                    setGpsLng(Number(e.target.value))
                  }} /></label>
                  <label>Verification Radius (m)<input type="range" min="50" max="500" value={gpsRadius} onChange={(e) => setGpsRadius(Number(e.target.value))} /><span>{gpsRadius}m</span></label>
                  <div className="map-preview">
                    {Number.isFinite(gpsLat) && Number.isFinite(gpsLng) ? (
                      <iframe
                        title="Shop location map"
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                        src={`https://www.google.com/maps?q=${encodeURIComponent(`${gpsLat},${gpsLng}`)}&z=17&output=embed`}
                      />
                    ) : (
                      <div className="map-empty">
                        <p className="muted" style={{ margin: 0 }}>Enter valid latitude/longitude to preview the map.</p>
                      </div>
                    )}
                  </div>
                  <div className="row gap wrap">
                    <button
                      type="button"
                      className="ghost btn-sm"
                      disabled={locatingGps}
                      onClick={() => {
                        if (!navigator.geolocation) {
                          setError('Geolocation is not available in this browser.')
                          return
                        }
                        setLocatingGps(true)
                        navigator.geolocation.getCurrentPosition(
                          (pos) => {
                            setGpsLat(pos.coords.latitude)
                            setGpsLng(pos.coords.longitude)
                            setMessage('Location captured. Review then Save GPS.')
                            setLocatingGps(false)
                          },
                          () => {
                            setError('Could not get your location. Please allow location permission and try again.')
                            setLocatingGps(false)
                          },
                          { enableHighAccuracy: true, timeout: 12000 },
                        )
                      }}
                    >
                      {locatingGps ? 'Locating...' : 'Use my location'}
                    </button>
                    {Number.isFinite(gpsLat) && Number.isFinite(gpsLng) && (
                      <a
                        className="ghost btn-sm"
                        href={`https://www.google.com/maps?q=${encodeURIComponent(`${gpsLat},${gpsLng}`)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Google Maps
                      </a>
                    )}
                    <button onClick={async () => {
                    setSavingGps(true)
                    try {
                      await setShopGps({lat: gpsLat, lng: gpsLng}, gpsRadius)
                      setMessage('Shop GPS saved.')
                      await loadData()
                    } catch (err) {
                      setError(err.message)
                    } finally {
                      setSavingGps(false)
                    }
                  }} disabled={savingGps}> {savingGps ? 'Saving...' : 'Save GPS'} </button>
                  </div>
                </div>
                <p className="muted" style={{marginTop: '8px'}}>Map preview updates instantly. Save to apply for GPS verification.</p>
              </article>
            </section>

            <section className="card">
              <button onClick={saveSettings} disabled={savingSettings}>{savingSettings ? 'Saving...' : 'Save Changes'}</button>
            </section>
          </>
        )}

        {employeeDetail ? (
          <section
            className="card modal-overlay"
            onClick={(event) => event.target === event.currentTarget && closeEmployeeDetail()}
          >
            <article className="card employee-detail-drawer">
              {(() => {
                const detailSalary = salaryRows.find((row) => row.userId === employeeDetail.uid && row.month === employeeDetailMonth) || null
                const year = Number(String(employeeDetailMonth).slice(0, 4))
                const monthIndex = Number(String(employeeDetailMonth).slice(5, 7)) - 1
                const firstDay = new Date(Date.UTC(year, monthIndex, 1, 12, 0, 0, 0))
                const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
                const startOffset = (firstDay.getUTCDay() + 6) % 7
                const cells = Array.from({ length: startOffset + daysInMonth }, (_, index) => {
                  if (index < startOffset) return null
                  return index - startOffset + 1
                })
                const selectedDateKey = employeeDetailDateKey || `${employeeDetailMonth}-01`
                const selectedDay = employeeDetailRows.find((row) => row.date === selectedDateKey) || null
                const summary = {
                  present: employeeDetailRows.filter((row) => row.checkInAt).length,
                  late: employeeDetailRows.filter((row) => row.late).length,
                  overtime: employeeDetailRows.filter((row) => Number(row.overtimeMinutes || 0) > 0).length,
                  overtimeMinutes: employeeDetailRows.reduce((sum, row) => sum + Number(row.overtimeMinutes || 0), 0),
                }
                return (
                  <>
                    <div className="row between wrap employee-detail-head">
                      <div>
                        <p className="eyebrow">Employee Detail</p>
                        <h2 style={{ marginBottom: 4 }}>{employeeDetail.name || employeeDetail.email}</h2>
                        <p className="muted" style={{ margin: 0 }}>{employeeDetail.email}</p>
                      </div>
                      <div className="row gap wrap">
                        <button type="button" className="ghost btn-sm" onClick={openEmployeeAttendance}>
                          Open attendance
                        </button>
                        <button type="button" className="ghost btn-sm" onClick={openEmployeeSalary}>
                          Open salary
                        </button>
                            <button type="button" className="close" onClick={closeEmployeeDetail}>×</button>
                      </div>
                    </div>

                    <section className="salary-selected-summary">
                      <article className="card salary-summary-card">
                        <h3>Profile</h3>
                        <div className="grid two compact">
                          <p><strong>Role:</strong> {employeeDetail.role || 'employee'}</p>
                          <p><strong>Payroll Role:</strong> {employeeDetail.roleName || 'None'}</p>
                          <p><strong>Daily Rate:</strong> {Number(employeeDetail.dailyRate || 0).toLocaleString()}</p>
                          <p><strong>Paid Holidays:</strong> {Number(employeeDetail.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 1)}</p>
                          <p><strong>Attendance Days:</strong> {employeeDetailRows.length}</p>
                        </div>
                      </article>
                      <article className="card salary-summary-card">
                        <h3>Month Summary</h3>
                        <div className="grid two compact">
                          <p><strong>Present:</strong> {summary.present}</p>
                          <p><strong>Late:</strong> {summary.late}</p>
                          <p><strong>OT Days:</strong> {summary.overtime}</p>
                          <p><strong>OT Minutes:</strong> {summary.overtimeMinutes}</p>
                          <p><strong>Salary Record:</strong> {detailSalary ? 'Available' : 'Not generated'}</p>
                          <p><strong>Month:</strong> {employeeDetailMonth}</p>
                        </div>
                      </article>
                    </section>

                    <div className="salary-calendar-wrap">
                      <article className="card salary-calendar-card">
                        <div className="row between wrap" style={{ marginBottom: 8 }}>
                          <div>
                            <h3 style={{ marginBottom: 4 }}>Attendance Calendar</h3>
                            <p className="muted" style={{ margin: 0 }}>Select a day for in/out and overtime details.</p>
                          </div>
                          <label style={{ minWidth: 180 }}>
                            <input
                              type="month"
                              value={employeeDetailMonth}
                              onChange={(event) => {
                                setEmployeeDetailMonth(event.target.value)
                                setEmployeeDetailDateKey('')
                              }}
                            />
                          </label>
                        </div>
                        <div className="calendar-grid">
                          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                            <span key={day} className="calendar-weekday">{day}</span>
                          ))}
                          {employeeDetailLoading ? (
                            <div className="trend-loading muted">Loading calendar...</div>
                          ) : null}
                          {cells.map((day, index) => {
                            if (!day) return <div key={`detail-empty-${index}`} className="calendar-cell empty" />
                            const dayKey = `${employeeDetailMonth}-${String(day).padStart(2, '0')}`
                            const row = employeeDetailRows.find((entry) => entry.date === dayKey) || null
                            const status = row
                              ? row.checkInAt
                                ? row.checkOutAt
                                  ? 'present'
                                  : 'open'
                                : 'absent'
                              : 'absent'
                            const overtimeHours = Math.round((Number(row?.overtimeMinutes || 0) / 60) * 100) / 100
                            return (
                              <button
                                key={dayKey}
                                type="button"
                                className={`calendar-cell ${status} ${selectedDateKey === dayKey ? 'selected' : ''}`}
                                onClick={() => setEmployeeDetailDateKey(dayKey)}
                              >
                                <span className="calendar-day">{day}</span>
                                <span className="calendar-status">{row ? (row.checkInAt ? 'Present' : 'Absent') : 'Absent'}</span>
                                <span className="calendar-time">{row?.checkInAt ? formatClock(row.checkInAt) : 'No check-in'}</span>
                                <span className="calendar-overtime">{overtimeHours > 0 ? `${overtimeHours}h OT` : status === 'absent' ? 'Missing' : 'No OT'}</span>
                              </button>
                            )
                          })}
                        </div>
                      </article>

                      <article className="card salary-day-detail">
                        <h3 style={{ marginBottom: 6 }}>Selected Day</h3>
                        <p className="muted" style={{ marginTop: 0 }}>
                          {selectedDateKey} • {selectedDay?.checkInAt ? (selectedDay.checkOutAt ? 'Present' : 'Open shift') : 'Absent'}
                        </p>
                        <div className="grid two compact salary-day-grid">
                          <p><strong>Check In:</strong> {selectedDay?.checkInAt ? formatClock(selectedDay.checkInAt) : '-'}</p>
                          <p><strong>Check Out:</strong> {selectedDay?.checkOutAt ? formatClock(selectedDay.checkOutAt) : '-'}</p>
                          <p><strong>Worked:</strong> {formatDurationMs(Number(selectedDay?.workedMinutes || 0) * 60000)}</p>
                          <p><strong>OT:</strong> {Math.round((Number(selectedDay?.overtimeMinutes || 0) / 60) * 100) / 100}h</p>
                          <p><strong>OT Pay:</strong> {Number(selectedDay?.overtimePay || 0).toLocaleString()}</p>
                          <p><strong>Season:</strong> {selectedDay?.overtimeLabel || '-'}</p>
                        </div>
                        <p className="salary-day-note muted">
                          {selectedDay?.checkInAt
                            ? selectedDay?.checkOutAt
                              ? 'This day is closed and payroll-ready.'
                              : 'Employee checked in but has not checked out yet.'
                            : 'No attendance record was found for this date.'}
                        </p>
                      </article>
                    </div>
                  </>
                )
              })()}
            </article>
          </section>
        ) : null}

        {loading && <section className="card"><p className="muted">Loading admin data...</p></section>}
      </section>
    </main>
  )
}

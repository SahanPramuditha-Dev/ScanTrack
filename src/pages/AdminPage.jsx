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
  getLateAlerts,
  getTokenHistory,
  getTokenStats,
  getAttendanceDailyForRange,
  getAdminLogs,
  getAdminSettings,
  getDailyPaymentsForMonth,
  getEmployeeAttendanceForMonth,
  getEmployeeSalaryRecords,
  getActiveTvDisplaySession,
  getEmployees,
  updateAttendanceDaily,
  deleteAttendanceDaily,
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
import { MapPicker } from '../components/MapPicker'
import {
  KpiCard,
  AttendanceTrendChart,
  LateArrivalsChart,
  EmployeeStatusChart,
  SalaryDistributionChart,
  PayrollSummaryChart,
} from '../components/AnalyticsCharts'
import { useDashboardAnalytics } from '../hooks/useDashboardAnalytics'
import { DataTable } from '../components/DataTable'
import { DatePicker } from '../components/DatePicker'
import { StatusBadge } from '../components/StatusBadge'

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

function formatRefreshInterval(interval) {
  if (!Number.isFinite(interval) || interval <= 0) return '-'
  if (interval === 60) return '1m'
  if (interval === 300) return '5m'
  if (interval === 3600) return '1h'
  if (interval === 86400) return 'Daily'
  return `${interval}s`
}

function formatTimeOnlyForInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function buildIsoFromDateAndTime(dateKey, timeValue) {
  if (!dateKey || !timeValue) return null
  const [hours, minutes] = String(timeValue).split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  return new Date(`${dateKey}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`).toISOString()
}

function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-'
  if (seconds < 60) return `${seconds}s`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`
  }
  return `${minutes}m ${String(secs).padStart(2, '0')}s`
}

function formatTokenSource(token) {
  if (!token) return 'Unknown'
  if (token.displaySessionId) return 'TV Session'
  if (token.issuedBy) return 'Admin'
  return 'System'
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

export function AdminPage({ user, pathname, routeSearch, navigate }) {
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
      housingAllowanceDefault: 0,
      transportAllowanceDefault: 0,
      medicalAllowanceDefault: 0,
      taxEnabled: false,
      taxLabel: 'PAYE',
      taxMode: 'percent',
      taxPercent: 0,
      taxFixed: 0,
      taxRelief: 0,
      attendanceIntegrationMode: 'manual',
      leaveIntegrationMode: 'manual',
      payslipDeliveryMode: 'portal_pdf',
    },
  })
  const [gpsLat, setGpsLat] = useState(APP_CONFIG.shopGps.lat)
  const [gpsLng, setGpsLng] = useState(APP_CONFIG.shopGps.lng)
  const [gpsRadius, setGpsRadius] = useState(APP_CONFIG.verificationRadiusMeters)
  const [savingGps, setSavingGps] = useState(false)
  const [locatingGps, setLocatingGps] = useState(false)
  const [uiTick, setUiTick] = useState(0)
  const [savingQrInterval, setSavingQrInterval] = useState(false)
  const [activeTvSession, setActiveTvSession] = useState(null)
  const [tokenExpiryFilter, setTokenExpiryFilter] = useState('all')
  const [activeTokenSecondsLeft, setActiveTokenSecondsLeft] = useState(0)
  const [dayCheckInTime, setDayCheckInTime] = useState('')
  const [dayCheckOutTime, setDayCheckOutTime] = useState('')
  const [savingAttendanceUpdate, setSavingAttendanceUpdate] = useState(false)
  const [markAbsent, setMarkAbsent] = useState(false)
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedDays, setSelectedDays] = useState(new Set())

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
  const [employeeProfileStatusFilter, setEmployeeProfileStatusFilter] = useState('all')
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
  const [employeeDetailSalaryRows, setEmployeeDetailSalaryRows] = useState([])
  const [employeeDetailView, setEmployeeDetailView] = useState('month')
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
  const [showEmployeeForm, setShowEmployeeForm] = useState(false)
  const [newEmpAllowedHolidays, setNewEmpAllowedHolidays] = useState('')
  const [newEmpPhone, setNewEmpPhone] = useState('')
  const [newEmpAddress, setNewEmpAddress] = useState('')
  const [newEmpDepartment, setNewEmpDepartment] = useState('')
  const [newEmpJoinDate, setNewEmpJoinDate] = useState('')
  const [newEmpStatus, setNewEmpStatus] = useState('active')
  const [newEmpEmployeeCode, setNewEmpEmployeeCode] = useState('')
  const [newEmpGrade, setNewEmpGrade] = useState('')
  const [newEmpEmploymentType, setNewEmpEmploymentType] = useState('permanent')
  const [newEmpAttendanceSource, setNewEmpAttendanceSource] = useState('manual')
  const [newEmpBankName, setNewEmpBankName] = useState('')
  const [newEmpBankAccountNo, setNewEmpBankAccountNo] = useState('')
  const [newEmpBankBranch, setNewEmpBankBranch] = useState('')
  const [newEmpTaxNumber, setNewEmpTaxNumber] = useState('')
  const [newEmpTaxLabel, setNewEmpTaxLabel] = useState('PAYE')
  const [newEmpHousingAllowance, setNewEmpHousingAllowance] = useState('')
  const [newEmpTransportAllowance, setNewEmpTransportAllowance] = useState('')
  const [newEmpMedicalAllowance, setNewEmpMedicalAllowance] = useState('')
  const [newEmpTaxEnabled, setNewEmpTaxEnabled] = useState(false)
  const [newEmpTaxMode, setNewEmpTaxMode] = useState('percent')
  const [newEmpTaxPercent, setNewEmpTaxPercent] = useState('')
  const [newEmpTaxFixed, setNewEmpTaxFixed] = useState('')
  const [newEmpTaxRelief, setNewEmpTaxRelief] = useState('')
  const [newEmpLoanBalance, setNewEmpLoanBalance] = useState('')
  const [newEmpLoanInstallment, setNewEmpLoanInstallment] = useState('')
  const [newEmpAdvanceBalance, setNewEmpAdvanceBalance] = useState('')
  const [newEmpAdvanceInstallment, setNewEmpAdvanceInstallment] = useState('')
  const [newEmpBonusAmount, setNewEmpBonusAmount] = useState('')
  const [newEmpFestivalBonus, setNewEmpFestivalBonus] = useState('')
  const [newEmpCommissionAmount, setNewEmpCommissionAmount] = useState('')
  const [newEmpNotes, setNewEmpNotes] = useState('')
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
        lateAlertsData,
        activeTvSessionData,
      ] = await Promise.all([
        getAdminLogs(date),
        getEmployees({ includeInactive: true }),
        getAdminSettings(),
        getTokenHistory(),
        getLateAlerts(date),
        getActiveTvDisplaySession(),
      ])
      setLogs(logsData)
      setEmployees(employeesData)
      setDirectory(employeesData) // directory is same as employees
      setAlerts(Array.isArray(lateAlertsData) ? lateAlertsData : [])
      setTokenHistory(tokenHistoryData)
      setActiveTvSession(activeTvSessionData)
      if (settingsData) {
        setSettings({
          ...settingsData,
          refreshInterval: Math.max(60, Number(settingsData.refreshInterval || APP_CONFIG.tokenRefreshSeconds)),
        })
        setGpsLat(settingsData.shopGps?.lat ?? APP_CONFIG.shopGps.lat)
        setGpsLng(settingsData.shopGps?.lng ?? APP_CONFIG.shopGps.lng)
        setGpsRadius(settingsData.verificationRadiusMeters ?? APP_CONFIG.verificationRadiusMeters)
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
    const selected = employeeDetailRows.find((row) => row.date === employeeDetailDateKey) || null
    setDayCheckInTime(formatTimeOnlyForInput(selected?.checkInAt || ''))
    setDayCheckOutTime(formatTimeOnlyForInput(selected?.checkOutAt || ''))
    setMarkAbsent(!selected?.checkInAt)
  }, [employeeDetailDateKey, employeeDetailRows])

  useEffect(() => {
    if (!pathname?.startsWith('/admin/employee-history')) return
    const params = new URLSearchParams(routeSearch || window.location.search)
    const uid = String(params.get('uid') || '').trim()
    if (!uid) return

    const month = params.get('month') || getTodayKey().slice(0, 7)
    const view = params.get('view') || 'month'
    const candidate = [...employees, ...directory].find((entry) => String(entry.uid || entry.id || entry.userId) === uid)

    if (candidate && candidate.uid !== employeeDetail?.uid) {
      setEmployeeDetail(candidate)
    }

    if (!candidate && uid && employeeDetail?.uid !== uid) {
      setEmployeeDetail({ uid, name: '', email: '' })
    }

    setEmployeeDetailMonth(month)
    setEmployeeDetailView(view === 'history' ? 'history' : 'month')
    setEmployeeDetailDateKey('')
  }, [pathname, routeSearch, employees, directory, employeeDetail?.uid])

  useEffect(() => {
    if (!employeeDetail?.uid) {
      setEmployeeDetailSalaryRows([])
      return undefined
    }

    let cancelled = false
    const loadEmployeeDetailSalary = async () => {
      try {
        const rows = await getEmployeeSalaryRecords(employeeDetail.uid, 100)
        if (!cancelled) {
          setEmployeeDetailSalaryRows(rows)
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    }

    loadEmployeeDetailSalary()

    return () => {
      cancelled = true
    }
  }, [employeeDetail?.uid])

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
    const now = Date.now()
    return tokenHistory
      .filter((t) => tokenStatusFilter === 'all' || 
        (tokenStatusFilter === 'active' && t.active) ||
        (tokenStatusFilter === 'expired' && !t.active))
      .filter((t) => {
        if (tokenExpiryFilter === 'expiresSoon') {
          return t.active && Number(t.expiresAtMs || 0) <= now + 5 * 60 * 1000
        }
        if (tokenExpiryFilter === 'longerThanHour') {
          return t.active && Number(t.expiresAtMs || 0) > now + 60 * 60 * 1000
        }
        return true
      })
      .filter((t) => {
        if (!keyword) return true
        return String(t.token || '').toLowerCase().includes(keyword) ||
          String(t.scansCount || 0).includes(keyword) ||
          String(t.issuedAt || '').toLowerCase().includes(keyword)
      })
  }, [tokenHistory, tokenSearch, tokenStatusFilter, tokenExpiryFilter])

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

  const analyticsData = useDashboardAnalytics(logs, employees, salaryRows, dashboardRange, date)

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

  useEffect(() => {
    if (!activeToken?.expiresAtMs || !activeToken?.active) {
      setActiveTokenSecondsLeft(0)
      return undefined
    }

    const update = () => {
      const left = Math.max(0, Math.floor((Number(activeToken.expiresAtMs) - Date.now()) / 1000))
      setActiveTokenSecondsLeft(left)
    }

    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [activeToken])

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
      .filter((entry) => entry.active !== false)
      .filter((entry) => (showInactiveEmployees ? true : entry.active !== false))
      .filter((entry) => {
        const role = String(entry.role || 'employee')
        return employeeRoleFilter === 'all' || role === employeeRoleFilter
      })
      .filter((entry) => employeeProfileStatusFilter === 'all' || String(entry.status || 'active') === employeeProfileStatusFilter)
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
  }, [directory, employeeRoleFilter, employeeSearch, employeeSort, employeeStatusFilter, employeeProfileStatusFilter, showInactiveEmployees])

  const pendingApprovalRows = useMemo(() => {
    return directory
      .filter((entry) => (entry.role || 'employee') !== 'admin' && entry.active === false)
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
  }, [directory])

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

  const resetEmployeeForm = useCallback(() => {
    setEditingEmployeeId('')
    setNewEmpName('')
    setNewEmpEmail('')
    setNewEmpRole('employee')
    setNewEmpRoleName('')
    setNewEmpDailyRate('')
    setNewEmpAllowedHolidays('')
    setNewEmpPhone('')
    setNewEmpAddress('')
    setNewEmpDepartment('')
    setNewEmpJoinDate('')
    setNewEmpStatus('active')
    setNewEmpEmployeeCode('')
    setNewEmpGrade('')
    setNewEmpEmploymentType('permanent')
    setNewEmpAttendanceSource(settings.payrollRules?.attendanceIntegrationMode || 'manual')
    setNewEmpBankName('')
    setNewEmpBankAccountNo('')
    setNewEmpBankBranch('')
    setNewEmpTaxNumber('')
    setNewEmpTaxLabel(settings.payrollRules?.taxLabel || 'PAYE')
    setNewEmpHousingAllowance('')
    setNewEmpTransportAllowance('')
    setNewEmpMedicalAllowance('')
    setNewEmpTaxEnabled(settings.payrollRules?.taxEnabled === true)
    setNewEmpTaxMode(settings.payrollRules?.taxMode || 'percent')
    setNewEmpTaxPercent('')
    setNewEmpTaxFixed('')
    setNewEmpTaxRelief('')
    setNewEmpLoanBalance('')
    setNewEmpLoanInstallment('')
    setNewEmpAdvanceBalance('')
    setNewEmpAdvanceInstallment('')
    setNewEmpBonusAmount('')
    setNewEmpFestivalBonus('')
    setNewEmpCommissionAmount('')
    setNewEmpNotes('')
  }, [settings.payrollRules])

  const fillEmployeeForm = useCallback((employee = {}) => {
    setEditingEmployeeId(employee.uid || employee.id || '')
    setNewEmpName(employee.name || '')
    setNewEmpEmail(employee.email || '')
    setNewEmpRole(employee.role || 'employee')
    setNewEmpRoleName(employee.roleName || '')
    setNewEmpDailyRate(String(employee.dailyRate ?? ''))
    setNewEmpAllowedHolidays(String(employee.allowedHolidays ?? ''))
    setNewEmpPhone(employee.phone || '')
    setNewEmpAddress(employee.address || '')
    setNewEmpDepartment(employee.department || '')
    setNewEmpJoinDate(employee.joinDate || '')
    setNewEmpStatus(employee.status || 'active')
    setNewEmpEmployeeCode(employee.employeeCode || '')
    setNewEmpGrade(employee.grade || '')
    setNewEmpEmploymentType(employee.employmentType || 'permanent')
    setNewEmpAttendanceSource(employee.attendanceSource || settings.payrollRules?.attendanceIntegrationMode || 'manual')
    setNewEmpBankName(employee.bankName || '')
    setNewEmpBankAccountNo(employee.bankAccountNo || '')
    setNewEmpBankBranch(employee.bankBranch || '')
    setNewEmpTaxNumber(employee.taxNumber || '')
    setNewEmpTaxLabel(employee.taxLabel || settings.payrollRules?.taxLabel || 'PAYE')
    setNewEmpHousingAllowance(String(employee.housingAllowance ?? ''))
    setNewEmpTransportAllowance(String(employee.transportAllowance ?? ''))
    setNewEmpMedicalAllowance(String(employee.medicalAllowance ?? ''))
    setNewEmpTaxEnabled(employee.taxEnabled === true)
    setNewEmpTaxMode(employee.taxMode || settings.payrollRules?.taxMode || 'percent')
    setNewEmpTaxPercent(String(employee.taxPercent ?? ''))
    setNewEmpTaxFixed(String(employee.taxFixed ?? ''))
    setNewEmpTaxRelief(String(employee.taxRelief ?? ''))
    setNewEmpLoanBalance(String(employee.loanBalance ?? ''))
    setNewEmpLoanInstallment(String(employee.loanInstallment ?? ''))
    setNewEmpAdvanceBalance(String(employee.advanceBalance ?? ''))
    setNewEmpAdvanceInstallment(String(employee.advanceInstallment ?? ''))
    setNewEmpBonusAmount(String(employee.bonusAmount ?? ''))
    setNewEmpFestivalBonus(String(employee.festivalBonus ?? ''))
    setNewEmpCommissionAmount(String(employee.commissionAmount ?? ''))
    setNewEmpNotes(employee.notes || '')
  }, [settings.payrollRules])

  const createEmployee = async (event) => {
    event.preventDefault()
    const isEditing = Boolean(editingEmployeeId)
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
          employeeCode: newEmpEmployeeCode,
          grade: newEmpGrade,
          employmentType: newEmpEmploymentType,
          dailyRate: Number(newEmpDailyRate || 0),
          allowedHolidays: Number(newEmpAllowedHolidays || 0),
          phone: newEmpPhone,
          address: newEmpAddress,
          department: newEmpDepartment,
          joinDate: newEmpJoinDate,
          status: newEmpStatus,
          attendanceSource: newEmpAttendanceSource,
          bankName: newEmpBankName,
          bankAccountNo: newEmpBankAccountNo,
          bankBranch: newEmpBankBranch,
          taxNumber: newEmpTaxNumber,
          taxLabel: newEmpTaxLabel,
          housingAllowance: newEmpHousingAllowance === '' ? null : Number(newEmpHousingAllowance),
          transportAllowance: newEmpTransportAllowance === '' ? null : Number(newEmpTransportAllowance),
          medicalAllowance: newEmpMedicalAllowance === '' ? null : Number(newEmpMedicalAllowance),
          taxEnabled: newEmpTaxEnabled,
          taxMode: newEmpTaxMode,
          taxPercent: newEmpTaxPercent === '' ? null : Number(newEmpTaxPercent),
          taxFixed: newEmpTaxFixed === '' ? null : Number(newEmpTaxFixed),
          taxRelief: newEmpTaxRelief === '' ? null : Number(newEmpTaxRelief),
          loanBalance: Number(newEmpLoanBalance || 0),
          loanInstallment: Number(newEmpLoanInstallment || 0),
          advanceBalance: Number(newEmpAdvanceBalance || 0),
          advanceInstallment: Number(newEmpAdvanceInstallment || 0),
          bonusAmount: Number(newEmpBonusAmount || 0),
          festivalBonus: Number(newEmpFestivalBonus || 0),
          commissionAmount: Number(newEmpCommissionAmount || 0),
          notes: newEmpNotes,
          updatedBy: user.uid || user.id,
        })
      } else {
await createEmployeeByAdmin({
          name: newEmpName,
          email: newEmpEmail.trim().toLowerCase(),
          role: newEmpRole,
          roleName: newEmpRoleName,
          employeeCode: newEmpEmployeeCode,
          grade: newEmpGrade,
          employmentType: newEmpEmploymentType,
          dailyRate: Number(newEmpDailyRate || 0),
          allowedHolidays: Number(newEmpAllowedHolidays || 0),
          phone: newEmpPhone,
          address: newEmpAddress,
          department: newEmpDepartment,
          joinDate: newEmpJoinDate,
          status: newEmpStatus,
          attendanceSource: newEmpAttendanceSource,
          bankName: newEmpBankName,
          bankAccountNo: newEmpBankAccountNo,
          bankBranch: newEmpBankBranch,
          taxNumber: newEmpTaxNumber,
          taxLabel: newEmpTaxLabel,
          housingAllowance: newEmpHousingAllowance === '' ? null : Number(newEmpHousingAllowance),
          transportAllowance: newEmpTransportAllowance === '' ? null : Number(newEmpTransportAllowance),
          medicalAllowance: newEmpMedicalAllowance === '' ? null : Number(newEmpMedicalAllowance),
          taxEnabled: newEmpTaxEnabled,
          taxMode: newEmpTaxMode,
          taxPercent: newEmpTaxPercent === '' ? null : Number(newEmpTaxPercent),
          taxFixed: newEmpTaxFixed === '' ? null : Number(newEmpTaxFixed),
          taxRelief: newEmpTaxRelief === '' ? null : Number(newEmpTaxRelief),
          loanBalance: Number(newEmpLoanBalance || 0),
          loanInstallment: Number(newEmpLoanInstallment || 0),
          advanceBalance: Number(newEmpAdvanceBalance || 0),
          advanceInstallment: Number(newEmpAdvanceInstallment || 0),
          bonusAmount: Number(newEmpBonusAmount || 0),
          festivalBonus: Number(newEmpFestivalBonus || 0),
          commissionAmount: Number(newEmpCommissionAmount || 0),
          notes: newEmpNotes,
          createdBy: user.uid || user.id,
        })
      }
      resetEmployeeForm()
      setShowEmployeeForm(false)
      setMessage(isEditing ? 'Employee updated.' : 'Employee access created.')
      await loadData()
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingEmployee(false)
    }
  }

  const startEditEmployee = (employee) => {
    setShowEmployeeForm(true)
    fillEmployeeForm(employee)
  }

  const cancelEditEmployee = () => {
    resetEmployeeForm()
    setShowEmployeeForm(false)
  }

  const openCreateEmployee = () => {
    resetEmployeeForm()
    setShowEmployeeForm(true)
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

  const approveEmployee = async (employee) => {
    const id = employee.uid || employee.id
    if (!id) return

    setError('')
    setMessage('')
    setSavingEmployee(true)
    try {
      await updateEmployeeByAdmin({
        id,
        name: employee.name || '',
        email: employee.email || '',
        role: employee.role || 'employee',
        roleName: employee.roleName || '',
        employeeCode: employee.employeeCode || '',
        grade: employee.grade || '',
        employmentType: employee.employmentType || 'permanent',
        dailyRate: Number(employee.dailyRate || 0),
        allowedHolidays: Number(employee.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 0),
        active: true,
        attendanceSource: employee.attendanceSource || settings.payrollRules?.attendanceIntegrationMode || 'manual',
        bankName: employee.bankName || '',
        bankAccountNo: employee.bankAccountNo || '',
        bankBranch: employee.bankBranch || '',
        taxNumber: employee.taxNumber || '',
        taxLabel: employee.taxLabel || settings.payrollRules?.taxLabel || 'PAYE',
        housingAllowance: employee.housingAllowance ?? null,
        transportAllowance: employee.transportAllowance ?? null,
        medicalAllowance: employee.medicalAllowance ?? null,
        taxEnabled: employee.taxEnabled === true,
        taxMode: employee.taxMode || settings.payrollRules?.taxMode || 'percent',
        taxPercent: employee.taxPercent ?? null,
        taxFixed: employee.taxFixed ?? null,
        taxRelief: employee.taxRelief ?? null,
        loanBalance: Number(employee.loanBalance || 0),
        loanInstallment: Number(employee.loanInstallment || 0),
        advanceBalance: Number(employee.advanceBalance || 0),
        advanceInstallment: Number(employee.advanceInstallment || 0),
        bonusAmount: Number(employee.bonusAmount || 0),
        festivalBonus: Number(employee.festivalBonus || 0),
        commissionAmount: Number(employee.commissionAmount || 0),
        updatedBy: user.uid || user.id,
      })
      setMessage(`${employee.name || employee.email || 'Employee'} approved.`)
      await loadData()
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingEmployee(false)
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

  const applyQrRefreshInterval = async () => {
    setError('')
    setMessage('')
    try {
      setSavingQrInterval(true)
      const nextInterval = Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds)
      await saveAdminSettings({ ...settings, refreshInterval: nextInterval })
      const activeSession = await getActiveTvDisplaySession()
      if (activeSession) {
        await createTvDisplaySession(user, nextInterval)
      }
      setMessage(`QR refresh interval saved: ${formatRefreshInterval(nextInterval)}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingQrInterval(false)
    }
  }

  const regenerateToken = async () => {
    setError('')
    setMessage('')
    try {
      await issueTvToken(user, Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds))
      setMessage(`New QR token generated (${formatRefreshInterval(Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds))}).`)
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
        setMessage(`TV display link copied (${formatRefreshInterval(Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds))}).`)
      } catch {
        window.prompt('Copy this TV display link:', session.launchUrl)
        setMessage(`TV display link generated (${formatRefreshInterval(Number(settings.refreshInterval || APP_CONFIG.tokenRefreshSeconds))}).`)
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const saveEmployeeAttendanceUpdate = async () => {
    if (!employeeDetail?.uid) {
      setError('Select an employee first.')
      return
    }
    if (!employeeDetailDateKey) {
      setError('Select a date to save attendance.')
      return
    }
    setError('')
    setMessage('')
    setSavingAttendanceUpdate(true)
    try {
      const payload = {}
      if (markAbsent) {
        payload.checkInAt = null
        payload.checkOutAt = null
        payload.late = false
        payload.overtimeMinutes = 0
        payload.workedMinutes = 0
        payload.overtimePay = 0
        payload.overtimeLabel = ''
      } else {
        const nextCheckIn = buildIsoFromDateAndTime(employeeDetailDateKey, dayCheckInTime)
        const nextCheckOut = buildIsoFromDateAndTime(employeeDetailDateKey, dayCheckOutTime)
        if (dayCheckInTime) payload.checkInAt = nextCheckIn
        else payload.checkInAt = null
        if (dayCheckOutTime) payload.checkOutAt = nextCheckOut
        else payload.checkOutAt = null
        if (!dayCheckInTime && !dayCheckOutTime) {
          payload.late = false
          payload.overtimeMinutes = 0
          payload.workedMinutes = 0
          payload.overtimePay = 0
          payload.overtimeLabel = ''
        }
      }
      await updateAttendanceDaily(employeeDetail.uid, employeeDetailDateKey, payload)
      setMessage('Attendance saved.')
      const rows = await getEmployeeAttendanceForMonth(employeeDetail.uid, employeeDetailMonth)
      setEmployeeDetailRows(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingAttendanceUpdate(false)
    }
  }

  const clearEmployeeAttendanceForDay = () => {
    setDayCheckInTime('')
    setDayCheckOutTime('')
    setMarkAbsent(true)
  }

  const deleteEmployeeAttendanceForDay = async () => {
    if (!employeeDetail?.uid || !employeeDetailDateKey) {
      setError('Select an employee and date first.')
      return
    }
    if (!window.confirm(`Delete attendance for ${employeeDetailDateKey}? This cannot be undone.`)) return
    setError('')
    setMessage('')
    setSavingAttendanceUpdate(true)
    try {
      await deleteAttendanceDaily(employeeDetail.uid, employeeDetailDateKey)
      setMessage('Attendance deleted.')
      const rows = await getEmployeeAttendanceForMonth(employeeDetail.uid, employeeDetailMonth)
      setEmployeeDetailRows(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingAttendanceUpdate(false)
    }
  }

  const bulkUpdateAttendance = async (action) => {
    if (!employeeDetail?.uid || selectedDays.size === 0) return
    setError('')
    setMessage('')
    setSavingAttendanceUpdate(true)
    try {
      const updates = Array.from(selectedDays).map((date) => {
        if (action === 'absent') {
          return updateAttendanceDaily(employeeDetail.uid, date, {
            checkInAt: null,
            checkOutAt: null,
            late: false,
            overtimeMinutes: 0,
            workedMinutes: 0,
            overtimePay: 0,
            overtimeLabel: '',
          })
        }
        return Promise.resolve()
      })
      await Promise.all(updates)
      setMessage(`${selectedDays.size} days updated.`)
      setSelectedDays(new Set())
      const rows = await getEmployeeAttendanceForMonth(employeeDetail.uid, employeeDetailMonth)
      setEmployeeDetailRows(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingAttendanceUpdate(false)
    }
  }

  const bulkDeleteAttendance = async () => {
    if (!employeeDetail?.uid || selectedDays.size === 0) return
    if (!window.confirm(`Delete attendance for ${selectedDays.size} days? This cannot be undone.`)) return
    setError('')
    setMessage('')
    setSavingAttendanceUpdate(true)
    try {
      const deletes = Array.from(selectedDays).map((date) => deleteAttendanceDaily(employeeDetail.uid, date))
      await Promise.all(deletes)
      setMessage(`${selectedDays.size} days deleted.`)
      setSelectedDays(new Set())
      const rows = await getEmployeeAttendanceForMonth(employeeDetail.uid, employeeDetailMonth)
      setEmployeeDetailRows(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingAttendanceUpdate(false)
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
      Allowances: r.allowancesTotal,
      Incentives: r.incentivePay,
      'Gross Salary': r.grossSalary,
      'Tax Label': r.taxLabel || '',
      'Tax Deduction': r.taxDeduction || 0,
      'Loan Installment': r.loanInstallment || 0,
      'Advance Installment': r.advanceInstallment || 0,
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
    const uid = String(employee.uid || employee.id || employee.userId || '')
    if (!uid) return

    setEmployeeDetail(employee)
    setEmployeeDetailMonth(salaryMonth || getTodayKey().slice(0, 7))
    setEmployeeDetailView('month')
    setEmployeeDetailDateKey('')
    navigate(
      `/admin/employee-history?uid=${encodeURIComponent(uid)}&month=${encodeURIComponent(salaryMonth || getTodayKey().slice(0, 7))}&view=month`,
      false,
    )
  }

  const closeEmployeeDetail = () => {
    setEmployeeDetail(null)
    setEmployeeDetailRows([])
    setEmployeeDetailDateKey('')
    if (pathname?.startsWith('/admin/employee-history')) {
      navigate('/admin', false)
    }
  }

  const exportEmployeeRecords = () => {
    if (!employeeDetail?.uid) return
    const attendanceRows = employeeDetailRows.map((row) => ({
      RecordType: 'Attendance',
      Employee: employeeDetail.name || employeeDetail.email,
      UserId: employeeDetail.uid,
      Date: row.date,
      CheckIn: row.checkInAt ? formatClock(row.checkInAt) : '',
      CheckOut: row.checkOutAt ? formatClock(row.checkOutAt) : '',
      Late: row.late ? 'Yes' : 'No',
      OvertimeHours: Math.round((Number(row.overtimeMinutes || 0) / 60) * 100) / 100,
      OvertimePay: Number(row.overtimePay || 0),
      WorkedMinutes: Number(row.workedMinutes || 0),
    }))
    const salaryRows = employeeDetailSalaryRows.map((row) => ({
      RecordType: 'Salary',
      Employee: employeeDetail.name || employeeDetail.email,
      UserId: row.userId,
      Month: row.month,
      BaseSalary: Number(row.baseSalary || 0),
      Allowances: Number(row.allowancesTotal || 0),
      Incentives: Number(row.incentivePay || 0),
      GrossSalary: Number(row.grossSalary || 0),
      TaxDeduction: Number(row.taxDeduction || 0),
      LoanInstallment: Number(row.loanInstallment || 0),
      AdvanceInstallment: Number(row.advanceInstallment || 0),
      Deductions: Number(row.deductions || 0),
      Bonus: Number(row.bonus || 0),
      FinalSalary: Number(row.finalSalary || 0),
      DaysPresent: row.daysPresent || 0,
      LateDays: row.lateDays || 0,
      OvertimeHours: Number(row.overtimeHours || 0),
    }))
    const rows = [...attendanceRows, ...salaryRows]
    if (!rows.length) {
      setMessage('No employee records available to export.')
      return
    }
    downloadCsv(`employee-${employeeDetail.uid}-history.csv`, rows)
    setMessage(`Exported ${rows.length} employee records.`)
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
              <div><span class="muted">Gross Salary</span><strong>${escapeHtml(Number(selected.grossSalary || 0).toLocaleString())}</strong></div>
              <div><span class="muted">OT Pay</span><strong>${escapeHtml(Number(selected.overtimePay || 0).toLocaleString())}</strong></div>
              <div><span class="muted">Deductions</span><strong>${escapeHtml(Number(selected.deductions || 0).toLocaleString())}</strong></div>
            </div>

            <div class="box">
              <h3>Employee & Payment Details</h3>
              <div class="grid">
                <p><strong>Employee ID</strong>${escapeHtml(selected.employeeCode || '-')}</p>
                <p><strong>Department</strong>${escapeHtml(selected.department || '-')}</p>
                <p><strong>Grade</strong>${escapeHtml(selected.grade || '-')}</p>
                <p><strong>Employment Type</strong>${escapeHtml(selected.employmentType || '-')}</p>
                <p><strong>Attendance Source</strong>${escapeHtml(selected.attendanceSource || '-')}</p>
                <p><strong>Bank</strong>${escapeHtml(selected.bankName || '-')}</p>
                <p><strong>Account No</strong>${escapeHtml(selected.bankAccountNo || '-')}</p>
                <p><strong>Branch</strong>${escapeHtml(selected.bankBranch || '-')}</p>
              </div>
            </div>

            <div class="box">
              <h3>Earnings & Deductions</h3>
              <div class="grid">
                <p><strong>Attendance Base</strong>${escapeHtml(Number(selected.attendanceBase || 0).toLocaleString())}</p>
                <p><strong>Manual Salary</strong>${escapeHtml(Number(selected.manualSalary || 0).toLocaleString())}</p>
                <p><strong>Housing Allowance</strong>${escapeHtml(Number(selected.housingAllowance || 0).toLocaleString())}</p>
                <p><strong>Transport Allowance</strong>${escapeHtml(Number(selected.transportAllowance || 0).toLocaleString())}</p>
                <p><strong>Medical Allowance</strong>${escapeHtml(Number(selected.medicalAllowance || 0).toLocaleString())}</p>
                <p><strong>Incentives</strong>${escapeHtml(Number(selected.incentivePay || 0).toLocaleString())}</p>
                <p><strong>Attendance Bonus</strong>${escapeHtml(Number(selected.bonus || 0).toLocaleString())}</p>
                <p><strong>Taxable Income</strong>${escapeHtml(Number(selected.taxableIncome || 0).toLocaleString())}</p>
                <p><strong>${escapeHtml(selected.taxLabel || 'Tax')}</strong>${escapeHtml(Number(selected.taxDeduction || 0).toLocaleString())}</p>
                <p><strong>Loan Installment</strong>${escapeHtml(Number(selected.loanInstallment || 0).toLocaleString())}</p>
                <p><strong>Advance Recovery</strong>${escapeHtml(Number(selected.advanceInstallment || 0).toLocaleString())}</p>
                <p><strong>Manual Deductions</strong>${escapeHtml(Number(selected.manualDeductions || 0).toLocaleString())}</p>
              </div>
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
                <h1>Analytics & Insights - {date}</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Real-time attendance analytics and key performance indicators.
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

            {/* KPI Cards */}
            <section className="kpi-grid">
              <KpiCard {...analyticsData.kpis.totalEmployees} />
              <KpiCard {...analyticsData.kpis.attendanceRate} />
              <KpiCard {...analyticsData.kpis.lateArrivals} />
              <KpiCard {...analyticsData.kpis.totalPayroll} />
            </section>

            {/* Charts Grid */}
            <section className="charts-grid">
              <div className="chart-card">
                <AttendanceTrendChart data={analyticsData.attendanceTrend} />
              </div>
              <div className="chart-card">
                <LateArrivalsChart data={analyticsData.lateByTime} />
              </div>
              <div className="chart-card">
                <EmployeeStatusChart data={analyticsData.employeeStatusData} />
              </div>
              <div className="chart-card">
                <SalaryDistributionChart data={analyticsData.salaryData} />
              </div>
            </section>

            {/* Payroll Summary Chart */}
            <section className="card payroll-chart-section">
              <PayrollSummaryChart data={analyticsData.payrollData} height={350} />
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
              <DataTable
                data={dashboardSummary.recent || []}
                columns={[
                  {
                    key: 'employeeName',
                    header: 'Name',
                    sortable: true,
                  },
                  {
                    key: 'userId',
                    header: 'Email',
                    render: (log) => (
                      <div className="recent-email-cell">
                        <span>{employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || '-'}</span>
                        <code className="muted">{log.userId}</code>
                      </div>
                    ),
                    sortable: true,
                  },
                  {
                    key: 'type',
                    header: 'Type',
                    render: (log) => (log.action === 'checkIn' ? 'Check In' : 'Check Out'),
                    sortable: true,
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    render: (log) => (
                      log.action === 'checkIn' ? (
                        <span className={`pill ${log.late ? 'danger' : 'ok'}`}>
                          {log.late ? 'Late' : 'On Time'}
                        </span>
                      ) : '-'
                    ),
                    sortable: true,
                  },
                  {
                    key: 'time',
                    header: 'Time',
                    render: (log) => formatClock(log.clientTs),
                    sortable: true,
                  },
                ]}
                searchable={false}
                paginated={false}
                emptyMessage="No activity yet."
                className="recent-activity-table"
              />
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
                <label>Date
                  <DatePicker
                    value={date}
                    onChange={(newDate) => {
                      setDateTouched(true)
                      setDate(newDate)
                    }}
                    placeholder="Select date"
                  />
                </label>
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
                  <DataTable
                    data={paginatedLogs}
                    columns={[
                      {
                        key: 'index',
                        header: '#',
                        render: (_, index) => (attendancePage - 1) * PAGE_SIZE + index + 1,
                        sortable: false
                      },
                      {
                        key: 'employeeName',
                        header: 'Name',
                        sortable: true
                      },
                      {
                        key: 'userId',
                        header: 'Email/ID',
                        render: (log) => (
                          <div className="recent-email-cell">
                            <span>{employeeLookupById.get(String(log.userId))?.email || log.employeeEmail || '-'}</span>
                            <code className="muted">{log.userId}</code>
                          </div>
                        ),
                        sortable: true
                      },
                      {
                        key: 'action',
                        header: 'Type',
                        render: (log) => (
                          <span className="pill neutral">{log.action === 'checkIn' ? 'Check In' : 'Check Out'}</span>
                        ),
                        sortable: true
                      },
                      {
                        key: 'status',
                        header: 'Status',
                        render: (log) => (
                          log.action === 'checkIn' ? (
                            <StatusBadge status={log.late ? 'late' : 'on-time'} />
                          ) : (
                            <span className="muted">-</span>
                          )
                        ),
                        sortable: true
                      },
                      {
                        key: 'date',
                        header: 'Date',
                        sortable: true
                      },
                      {
                        key: 'time',
                        header: 'Time',
                        render: (log) => (
                          <div className="row gap wrap">
                            <span>{formatClock(log.clientTs)}</span>
                            <span className="muted" style={{ fontSize: '0.82rem' }}>{formatRelative(log.clientTs)}</span>
                          </div>
                        ),
                        sortable: false
                      },
                      ...(showGpsColumn ? [
                        {
                          key: 'gps',
                          header: 'GPS',
                          render: (log) => (
                            <span className="gps-coord">
                              {log.gps ? `${log.gps.lat?.toFixed(4)},${log.gps.lng?.toFixed(4)}` : '-'}
                            </span>
                          ),
                          sortable: false
                        },
                        {
                          key: 'map',
                          header: 'Map',
                          render: (log) => (
                            log.gps?.lat && log.gps?.lng ? (
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
                            )
                          ),
                          sortable: false
                        }
                      ] : []),
                      {
                        key: 'actions',
                        header: 'Actions',
                        render: (log) => (
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
                        ),
                        sortable: false
                      }
                    ]}
                    searchable={true}
                    paginated={false} // Using existing pagination
                    emptyMessage="No attendance records found."
                    className="attendance-logs-table"
                  />
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
                  <DataTable
                    data={filteredDirectoryForAttendance}
                    columns={[
                      {
                        key: 'name',
                        header: 'Name',
                        render: (item) => item.name || item.email,
                        sortable: true
                      },
                      {
                        key: 'id',
                        header: 'ID',
                        render: (item) => (
                          <div className="recent-email-cell">
                            <span>{item.email || '-'}</span>
                            <code className="muted">{item.uid}</code>
                          </div>
                        ),
                        sortable: true
                      },
                      {
                        key: 'status',
                        header: 'Status',
                        render: (item) => (
                          <StatusBadge status={item.late ? 'late' : 'on-time'} />
                        ),
                        sortable: true
                      },
                      {
                        key: 'checkIn',
                        header: 'Check In',
                        render: (item) => formatClock(item.checkInAt),
                        sortable: true
                      },
                      {
                        key: 'checkOut',
                        header: 'Check Out',
                        render: (item) => formatClock(item.checkOutAt),
                        sortable: true
                      },
                      {
                        key: 'worked',
                        header: 'Worked',
                        render: (item) => {
                          const inMs = item.checkInAt ? new Date(item.checkInAt).getTime() : NaN
                          const outMs = item.checkOutAt ? new Date(item.checkOutAt).getTime() : NaN
                          const worked = Number.isFinite(inMs) && Number.isFinite(outMs) ? outMs - inMs : NaN
                          return formatDurationMs(worked)
                        },
                        sortable: false
                      },
                      {
                        key: 'ot',
                        header: 'OT',
                        render: (item) => Number(item.overtimeMinutes || 0) > 0 ? (
                          <span className="pill ok">{Math.round((Number(item.overtimeMinutes || 0) / 60) * 100) / 100}h OT</span>
                        ) : (
                          <span className="muted">-</span>
                        ),
                        sortable: true
                      },
                      {
                        key: 'actions',
                        header: 'Action',
                        render: (item) => (
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
                        ),
                        sortable: false
                      }
                    ]}
                    searchable={true}
                    paginated={false}
                    emptyMessage="No employees found for this date."
                    className="attendance-summary-table"
                  />
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
          <div className="employee-page">
            <section className="card admin-top-row employee-page-hero">
              <div className="employee-hero-copy">
                <p className="eyebrow">Employee Directory</p>
                <h1>Today&apos;s check-in status</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Search staff, sort by status, and open a detailed monthly view from any card.
                </p>
                <div className="employee-hero-metrics">
                  <article>
                    <span>Active employees</span>
                    <strong>{directorySummary.totalEmployees}</strong>
                  </article>
                  <article>
                    <span>Checked in</span>
                    <strong>{directorySummary.checkedIn}</strong>
                  </article>
                  <article>
                    <span>Late today</span>
                    <strong>{directorySummary.late}</strong>
                  </article>
                  <article>
                    <span>Pending approvals</span>
                    <strong>{pendingApprovalRows.length}</strong>
                  </article>
                </div>
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
                  <button type="button" className="btn-sm" onClick={openCreateEmployee}>Add Employee</button>
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

            <section className="stats-grid employee-stats-grid">
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
              <div className="employee-toolbar-head">
                <div>
                  <h3 style={{ marginBottom: 4 }}>Directory Controls</h3>
                  <p className="muted" style={{ margin: 0 }}>Refine the list by operational status and employee profile state.</p>
                </div>
                <span className="pill neutral">{directoryRows.length} visible</span>
              </div>
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
                <label>Profile Status
                  <select value={employeeProfileStatusFilter} onChange={(e) => setEmployeeProfileStatusFilter(e.target.value)}>
                    <option value="all">All profiles</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="on_leave">On Leave</option>
                    <option value="terminated">Terminated</option>
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
                <span className="pill neutral">Pending approvals: {pendingApprovalRows.length}</span>
                <span className="pill neutral">{showInactiveEmployees ? 'Inactive visible' : 'Inactive hidden'}</span>
              </div>
            </section>

            <section className="card employee-setup-card">
              <div className="row between wrap employee-setup-head" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>Employee Setup</h3>
                  <p className="muted" style={{ margin: 0 }}>
                    Open the form only when you need to add a new employee or update an existing one.
                  </p>
                </div>
                <div className="row gap">
                  {showEmployeeForm ? (
                    <button type="button" className="ghost btn-sm" onClick={cancelEditEmployee}>
                      {editingEmployeeId ? 'Close edit' : 'Close form'}
                    </button>
                  ) : (
                    <button type="button" className="btn-sm" onClick={openCreateEmployee}>
                      Add Employee
                    </button>
                  )}
                </div>
              </div>
              {showEmployeeForm ? (
                <form className="employee-form" onSubmit={createEmployee}>
                  <div className="employee-form-shell">
                    <div className="employee-form-main">
                      <section className="employee-form-section">
                        <div className="employee-form-section-head">
                          <div>
                            <h4>Identity & Access</h4>
                            <p className="muted">Core profile details for login, permissions, and directory records.</p>
                          </div>
                          <span className="pill neutral">{editingEmployeeId ? 'Editing profile' : 'New profile'}</span>
                        </div>
                        <div className="employee-form-grid">
                          <label>Name<input value={newEmpName} onChange={(e) => setNewEmpName(e.target.value)} required /></label>
                          <label>Email<input type="email" value={newEmpEmail} onChange={(e) => setNewEmpEmail(e.target.value)} required /></label>
                          <label>Employee ID
                            <input value={newEmpEmployeeCode} onChange={(e) => setNewEmpEmployeeCode(e.target.value)} placeholder="e.g. EMP-1024" />
                          </label>
                          <label>Grade
                            <input value={newEmpGrade} onChange={(e) => setNewEmpGrade(e.target.value)} placeholder="e.g. A1, Senior, L2" />
                          </label>
                          <label>Permission Role
                            <select value={newEmpRole} onChange={(e) => setNewEmpRole(e.target.value)}>
                              <option value="employee">Employee</option>
                              <option value="admin">Admin</option>
                            </select>
                          </label>
                          <label>Payroll Role
                            <select value={newEmpRoleName} onChange={(e) => setNewEmpRoleName(e.target.value)}>
                              <option value="">No payroll role</option>
                              {roles.map((role) => (
                                <option key={role.id || role.roleName} value={role.roleName}>{role.roleName} ({role.payType})</option>
                              ))}
                            </select>
                          </label>
                          <label>Phone
                            <input type="tel" value={newEmpPhone} onChange={(e) => setNewEmpPhone(e.target.value)} placeholder="e.g. +94 77 123 4567" />
                          </label>
                          <label>Department
                            <input value={newEmpDepartment} onChange={(e) => setNewEmpDepartment(e.target.value)} placeholder="e.g. Sales, IT, HR" />
                          </label>
                          <label>Join Date
                            <input type="date" value={newEmpJoinDate} onChange={(e) => setNewEmpJoinDate(e.target.value)} />
                          </label>
                          <label>Status
                            <select value={newEmpStatus} onChange={(e) => setNewEmpStatus(e.target.value)}>
                              <option value="active">Active</option>
                              <option value="contract">Contract</option>
                              <option value="resigned">Resigned</option>
                              <option value="inactive">Inactive</option>
                              <option value="on_leave">On Leave</option>
                              <option value="terminated">Terminated</option>
                            </select>
                          </label>
                          <label className="employee-form-field span-2">Address
                            <textarea
                              value={newEmpAddress}
                              onChange={(e) => setNewEmpAddress(e.target.value)}
                              placeholder="Full address"
                              rows="2"
                            />
                          </label>
                          <label className="employee-form-field span-2">Notes
                            <textarea
                              value={newEmpNotes}
                              onChange={(e) => setNewEmpNotes(e.target.value)}
                              placeholder="Additional notes"
                              rows="2"
                            />
                          </label>
                        </div>
                      </section>

                      <section className="employee-form-section">
                        <div className="employee-form-section-head">
                          <div>
                            <h4>Work Setup</h4>
                            <p className="muted">Attendance source, employment type, and the base payroll setup.</p>
                          </div>
                        </div>
                        <div className="employee-form-grid">
                          <label>Daily Rate
                            <input type="number" min="0" step="any" value={newEmpDailyRate} onChange={(e) => setNewEmpDailyRate(e.target.value)} placeholder="e.g. 2500" />
                          </label>
                          <label>Paid Holidays
                            <input type="number" min="0" value={newEmpAllowedHolidays} onChange={(e) => setNewEmpAllowedHolidays(e.target.value)} placeholder="e.g. 1" />
                          </label>
                          <label>Employment Type
                            <select value={newEmpEmploymentType} onChange={(e) => setNewEmpEmploymentType(e.target.value)}>
                              <option value="permanent">Permanent</option>
                              <option value="contract">Contract</option>
                              <option value="temporary">Temporary</option>
                              <option value="intern">Intern</option>
                            </select>
                          </label>
                          <label>Attendance Source
                            <select value={newEmpAttendanceSource} onChange={(e) => setNewEmpAttendanceSource(e.target.value)}>
                              <option value="manual">Manual</option>
                              <option value="biometric">Biometric</option>
                              <option value="integrated">Integrated Device/API</option>
                            </select>
                          </label>
                        </div>
                      </section>

                      <section className="employee-form-section">
                        <div className="employee-form-section-head">
                          <div>
                            <h4>Compensation & Recoveries</h4>
                            <p className="muted">Allowances, incentives, loans, and salary advance deductions.</p>
                          </div>
                        </div>
                        <div className="employee-form-grid">
                          <label>Housing Allowance
                            <input type="number" min="0" step="any" value={newEmpHousingAllowance} onChange={(e) => setNewEmpHousingAllowance(e.target.value)} placeholder="Default from settings if empty" />
                          </label>
                          <label>Transport Allowance
                            <input type="number" min="0" step="any" value={newEmpTransportAllowance} onChange={(e) => setNewEmpTransportAllowance(e.target.value)} placeholder="Default from settings if empty" />
                          </label>
                          <label>Medical Allowance
                            <input type="number" min="0" step="any" value={newEmpMedicalAllowance} onChange={(e) => setNewEmpMedicalAllowance(e.target.value)} placeholder="Default from settings if empty" />
                          </label>
                          <label>Performance Bonus
                            <input type="number" min="0" step="any" value={newEmpBonusAmount} onChange={(e) => setNewEmpBonusAmount(e.target.value)} placeholder="This month / recurring" />
                          </label>
                          <label>Festival Bonus
                            <input type="number" min="0" step="any" value={newEmpFestivalBonus} onChange={(e) => setNewEmpFestivalBonus(e.target.value)} placeholder="One-time or seasonal" />
                          </label>
                          <label>Commission
                            <input type="number" min="0" step="any" value={newEmpCommissionAmount} onChange={(e) => setNewEmpCommissionAmount(e.target.value)} placeholder="Sales or incentive pay" />
                          </label>
                          <label>Loan Balance
                            <input type="number" min="0" step="any" value={newEmpLoanBalance} onChange={(e) => setNewEmpLoanBalance(e.target.value)} placeholder="Outstanding employee loan" />
                          </label>
                          <label>Loan Installment
                            <input type="number" min="0" step="any" value={newEmpLoanInstallment} onChange={(e) => setNewEmpLoanInstallment(e.target.value)} placeholder="Monthly deduction" />
                          </label>
                          <label>Advance Balance
                            <input type="number" min="0" step="any" value={newEmpAdvanceBalance} onChange={(e) => setNewEmpAdvanceBalance(e.target.value)} placeholder="Outstanding salary advance" />
                          </label>
                          <label>Advance Installment
                            <input type="number" min="0" step="any" value={newEmpAdvanceInstallment} onChange={(e) => setNewEmpAdvanceInstallment(e.target.value)} placeholder="Monthly recovery" />
                          </label>
                        </div>
                      </section>

                      <section className="employee-form-section">
                        <div className="employee-form-section-head">
                          <div>
                            <h4>Banking & Tax</h4>
                            <p className="muted">Payout destination and statutory deduction settings.</p>
                          </div>
                        </div>
                        <div className="employee-form-grid">
                          <label>Bank Name
                            <input value={newEmpBankName} onChange={(e) => setNewEmpBankName(e.target.value)} placeholder="Bank for salary transfer" />
                          </label>
                          <label>Bank Account No
                            <input value={newEmpBankAccountNo} onChange={(e) => setNewEmpBankAccountNo(e.target.value)} placeholder="Masked or full account number" />
                          </label>
                          <label>Bank Branch
                            <input value={newEmpBankBranch} onChange={(e) => setNewEmpBankBranch(e.target.value)} placeholder="Branch / routing reference" />
                          </label>
                          <label>Tax Label
                            <input value={newEmpTaxLabel} onChange={(e) => setNewEmpTaxLabel(e.target.value)} placeholder="e.g. PAYE" />
                          </label>
                          <label>Tax Number
                            <input value={newEmpTaxNumber} onChange={(e) => setNewEmpTaxNumber(e.target.value)} placeholder="TIN / tax reference" />
                          </label>
                          <label>Tax Type
                            <select value={newEmpTaxMode} onChange={(e) => setNewEmpTaxMode(e.target.value)}>
                              <option value="percent">Percentage</option>
                              <option value="fixed">Fixed Amount</option>
                            </select>
                          </label>
                          <label>Tax Percent
                            <input type="number" min="0" step="0.01" value={newEmpTaxPercent} onChange={(e) => setNewEmpTaxPercent(e.target.value)} placeholder="Applied to taxable income" />
                          </label>
                          <label>Fixed Tax
                            <input type="number" min="0" step="any" value={newEmpTaxFixed} onChange={(e) => setNewEmpTaxFixed(e.target.value)} placeholder="Used when tax type is fixed" />
                          </label>
                          <label>Tax Relief
                            <input type="number" min="0" step="any" value={newEmpTaxRelief} onChange={(e) => setNewEmpTaxRelief(e.target.value)} placeholder="Relief before tax calculation" />
                          </label>
                          <label className="employee-form-toggle">
                            <span>Enable Tax Deduction</span>
                            <input type="checkbox" checked={newEmpTaxEnabled} onChange={(e) => setNewEmpTaxEnabled(e.target.checked)} />
                          </label>
                        </div>
                      </section>
                    </div>

                    <aside className="employee-form-sidebar">
                      <section className="employee-form-summary">
                        <h4>Setup Snapshot</h4>
                        <div className="employee-summary-list">
                          <p><span>Profile</span><strong>{editingEmployeeId ? 'Updating existing employee' : 'Creating new employee'}</strong></p>
                          <p><span>Attendance</span><strong>{newEmpAttendanceSource || 'Manual'}</strong></p>
                          <p><span>Employment</span><strong>{newEmpEmploymentType || 'Permanent'}</strong></p>
                          <p><span>Status</span><strong>{newEmpStatus || 'Active'}</strong></p>
                          <p><span>Payroll role</span><strong>{newEmpRoleName || 'No payroll role'}</strong></p>
                          <p><span>Tax</span><strong>{newEmpTaxEnabled ? `${newEmpTaxLabel || 'Tax'} enabled` : 'Not enabled'}</strong></p>
                        </div>
                        <div className="inline-pills employee-form-pills">
                          <span className="pill neutral">{newEmpDepartment || 'No department'}</span>
                          <span className="pill neutral">{newEmpGrade || 'No grade'}</span>
                          <span className="pill neutral">{newEmpRole === 'admin' ? 'Admin access' : 'Employee access'}</span>
                        </div>
                      </section>

                      <div className="employee-form-actions">
                        <button type="submit" disabled={savingEmployee}>
                          {savingEmployee ? 'Saving...' : editingEmployeeId ? 'Save Employee' : 'Add Employee'}
                        </button>
                        <p className="muted employee-form-help">
                          Start with identity and work setup. Banking, tax, and recovery fields can be completed progressively.
                        </p>
                      </div>
                    </aside>
                  </div>
                </form>
              ) : (
                <div className="employee-form-collapsed">
                  <div className="employee-form-collapsed-copy">
                    <p className="muted" style={{ margin: 0 }}>
                      Use <strong>Add Employee</strong> to open the form, or click <strong>Edit</strong> on any employee record.
                    </p>
                  </div>
                </div>
              )}
            </section>

            {pendingApprovalRows.length > 0 && (
              <section className="card employee-section-card">
                <div className="row between wrap employee-section-head" style={{ marginBottom: 10 }}>
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Pending Approvals</h3>
                    <p className="muted" style={{ margin: 0 }}>New sign-ins waiting for admin approval.</p>
                  </div>
                  <span className="pill danger">{pendingApprovalRows.length} pending</span>
                </div>
                <section className="employee-grid">
                  {pendingApprovalRows.map((item) => (
                    <article key={`pending-${item.uid || item.id || item.email}`} className="card emp-card inactive pending">
                      <div className="emp-card-head">
                        <div className="emp-avatar inactive">{(item.name || 'E').slice(0, 2).toUpperCase()}</div>
                        <div className="emp-card-title">
                          <h3>{item.name || 'Pending employee'}</h3>
                          <p className="muted">{item.email}</p>
                        </div>
                        <span className="pill danger">Pending</span>
                      </div>
                      <div className="emp-meta">
                        <span className="muted">{item.roleName ? `Payroll role: ${item.roleName}` : 'Payroll role: None'}</span>
                        <span className="muted">Rate {Number(item.dailyRate || 0).toLocaleString()} | Holidays {Number(item.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 1)}</span>
                      </div>
                      <div className="emp-card-actions">
                        <button type="button" onClick={() => approveEmployee(item)} disabled={savingEmployee}>Approve</button>
                        <button type="button" className="ghost" onClick={() => startEditEmployee(item)}>Edit</button>
                        <button type="button" className="ghost danger" onClick={() => removeEmployee(item)}>Remove</button>
                      </div>
                    </article>
                  ))}
                </section>
              </section>
            )}

            <section className="employee-section-card">
              <div className="row between wrap employee-section-head">
                <div>
                  <h3 style={{ marginBottom: 4 }}>Employee Directory</h3>
                  <p className="muted" style={{ margin: 0 }}>Browse records, open monthly detail, or jump into updates from each card.</p>
                </div>
                <span className="pill neutral">{directoryRows.length} employees</span>
              </div>
              <section className="employee-grid">
                {directoryRows.map((item) => (
                  <article key={item.uid || item.email || item.name} className="card emp-card">
                  <div className="emp-card-head">
                    <div className={`emp-avatar ${item.active === false ? 'inactive' : ''}`}>{(item.name || 'E').slice(0, 2).toUpperCase()}</div>
                    <div className="emp-card-title">
                      <h3>{item.name}</h3>
                      <p className="muted">{item.email}</p>
                    </div>
                    <span className={`pill ${item.active === false ? 'danger' : item.late ? 'danger' : 'neutral'}`}>{item.active === false ? 'Pending' : item.status}</span>
                  </div>
                  <div className="emp-meta">
                    <span className="muted">{item.roleName ? `Payroll role: ${item.roleName}` : 'Payroll role: None'}</span>
                    <span className="muted">{item.department ? `Dept: ${item.department}` : ''}</span>
                    <span className="muted">{item.phone ? `Phone: ${item.phone}` : ''}</span>
                    <span className="muted">{item.checkInAt ? `In ${formatClock(item.checkInAt)}` : 'No check-in yet'}</span>
                    <span className="muted">{item.checkOutAt ? `Out ${formatClock(item.checkOutAt)}` : 'No check-out yet'}</span>
                    <span className="muted">Rate {Number(item.dailyRate || 0).toLocaleString()} | Holidays {Number(item.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 1)}</span>
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
                      Invite
                    </button>
                    <button type="button" className="ghost danger" onClick={() => removeEmployee(item)}>Remove</button>
                  </div>
                  </article>
                ))}
                {!directoryRows.length && (
                  <section className="card employee-empty-state">
                    <h4 style={{ marginBottom: 6 }}>No employees match these filters</h4>
                    <p className="muted" style={{ margin: 0 }}>Try changing the search, profile filters, or inactive toggle to broaden the results.</p>
                  </section>
                )}
              </section>
            </section>
          </div>
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
              <DataTable
                data={roles}
                columns={[
                  {
                    key: 'roleName',
                    header: 'Role Name',
                    sortable: true
                  },
                  {
                    key: 'payType',
                    header: 'Pay Type',
                    sortable: true
                  },
                  {
                    key: 'rate',
                    header: 'Rate',
                    render: (role) => Number(role.rate || 0).toLocaleString(),
                    sortable: true
                  },
                  {
                    key: 'actions',
                    header: 'Actions',
                    render: (role) => (
                      <div className="row gap wrap">
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
                      </div>
                    ),
                    sortable: false
                  }
                ]}
                searchable={true}
                paginated={false}
                emptyMessage="No roles defined yet."
                className="roles-table"
              />
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
                    <DatePicker
                      value={dailySalaryDate}
                      onChange={setDailySalaryDate}
                      placeholder="Select date"
                    />
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
                  <DataTable
                    data={filteredSalaryRows}
                    columns={[
                      {
                        key: 'employeeName',
                        header: 'Employee',
                        sortable: true
                      },
                      {
                        key: 'userId',
                        header: 'UID',
                        render: (row) => <code>{row.userId}</code>,
                        sortable: true
                      },
                      {
                        key: 'dailyRate',
                        header: 'Rate',
                        render: (row) => Number(row.dailyRate || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'daysPresent',
                        header: 'Present',
                        sortable: true
                      },
                      {
                        key: 'lateDays',
                        header: 'Late',
                        sortable: true
                      },
                      {
                        key: 'manualCount',
                        header: 'Manual Days',
                        sortable: true
                      },
                      {
                        key: 'overtimeHours',
                        header: 'OT Hrs',
                        render: (row) => Number(row.overtimeHours || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'overtimePay',
                        header: 'OT Pay',
                        render: (row) => Number(row.overtimePay || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'baseSalary',
                        header: 'Base',
                        render: (row) => Number(row.baseSalary || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'allowancesTotal',
                        header: 'Allowances',
                        render: (row) => Number(row.allowancesTotal || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'incentivePay',
                        header: 'Incentives',
                        render: (row) => Number(row.incentivePay || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'taxDeduction',
                        header: 'Tax',
                        render: (row) => Number(row.taxDeduction || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'deductions',
                        header: 'Deductions',
                        render: (row) => Number(row.deductions || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'bonus',
                        header: 'Bonus',
                        render: (row) => Number(row.bonus || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'finalSalary',
                        header: 'Final',
                        render: (row) => <strong>{Number(row.finalSalary || 0).toLocaleString()}</strong>,
                        sortable: true
                      }
                    ]}
                    onRowClick={(row) => setSalarySelectedUserId(row.userId)}
                    searchable={false}
                    paginated={false}
                    emptyMessage="No salary records yet. Click ’Regenerate Month’."
                    className="salary-table"
                  />
                ) : (
                  <DataTable
                    data={filteredDailyPayments}
                    columns={[
                      {
                        key: 'date',
                        header: 'Date',
                        sortable: true
                      },
                      {
                        key: 'employeeName',
                        header: 'Employee',
                        sortable: true
                      },
                      {
                        key: 'userId',
                        header: 'UID',
                        render: (row) => <code>{row.userId}</code>,
                        sortable: true
                      },
                      {
                        key: 'dailySalary',
                        header: 'Daily Salary',
                        render: (row) => Number(row.dailySalary || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'overtimeHours',
                        header: 'OT Hrs',
                        render: (row) => Number(row.overtimeHours || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'overtimePay',
                        header: 'OT Pay',
                        render: (row) => Number(row.overtimePay || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'totalDeductions',
                        header: 'Deductions',
                        render: (row) => Number(row.totalDeductions || 0).toLocaleString(),
                        sortable: true
                      },
                      {
                        key: 'netPay',
                        header: 'Net Pay',
                        render: (row) => <strong>{Number(row.netPay || 0).toLocaleString()}</strong>,
                        sortable: true
                      },
                      {
                        key: 'notes',
                        header: 'Notes',
                        sortable: false
                      },
                      {
                        key: 'actions',
                        header: 'Actions',
                        render: (row) => (
                          <div className="row gap wrap">
                            <button className="ghost btn-sm" onClick={() => openDailyPaymentModal(row)}>Edit</button>
                            <button className="ghost btn-sm danger" onClick={async () => {
                              if (window.confirm('Delete this daily payment?')) {
                                await deleteDailyPayment(row.id)
                                await loadDailyPayments()
                                setMessage('Daily payment deleted.')
                              }
                            }}>Delete</button>
                          </div>
                        ),
                        sortable: false
                      }
                    ]}
                    searchable={false}
                    paginated={false}
                    emptyMessage="No daily payments. Click ’Add Daily Payment’."
                    className="daily-payments-table"
                  />
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
                            <p><strong>Allowances:</strong> {Number(selected.allowancesTotal || 0).toLocaleString()}</p>
                            <p><strong>Incentives:</strong> {Number(selected.incentivePay || 0).toLocaleString()}</p>
                            <p><strong>Gross Salary:</strong> {Number(selected.grossSalary || 0).toLocaleString()}</p>
                            <p><strong>Unpaid Ded:</strong> {Number(selected.attendanceUnpaidDed || 0).toLocaleString()}</p>
                            <p><strong>Late Ded:</strong> {Number(selected.lateDeduction || 0).toLocaleString()}</p>
                            <p><strong>Manual Ded:</strong> {Number(selected.manualDeductions || 0).toLocaleString()}</p>
                            <p><strong>{selected.taxLabel || 'Tax'}:</strong> {Number(selected.taxDeduction || 0).toLocaleString()}</p>
                            <p><strong>Loan Ded:</strong> {Number(selected.loanInstallment || 0).toLocaleString()}</p>
                            <p><strong>Advance Ded:</strong> {Number(selected.advanceInstallment || 0).toLocaleString()}</p>
                            <p><strong>Total Ded:</strong> {Number(selected.deductions || 0).toLocaleString()}</p>
                            <p><strong>Attendance Bonus:</strong> {Number(selected.bonus || 0).toLocaleString()}</p>
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
                      <p className="muted" style={{ margin: 0 }}>
                        Refresh interval: <strong title="How often the QR code expires and regenerates for security">{formatRefreshInterval(Number(settings.refreshInterval))}</strong>
                      </p>
                      {activeTvSession ? (
                        <p className="muted" style={{ margin: '6px 0 0' }}>
                          TV session active • interval {formatRefreshInterval(activeTvSession.refreshInterval)}
                        </p>
                      ) : null}
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
                    <div className="row gap" style={{ marginTop: 12, alignItems: 'center' }}>
                      <button
                        type="button"
                        className="primary"
                        disabled={savingQrInterval}
                        onClick={applyQrRefreshInterval}
                        style={{ minWidth: 160 }}
                      >
                        {savingQrInterval ? 'Saving...' : 'Save QR Interval'}
                      </button>
                      <span className="muted">
                        Saves the selected interval and updates the current TV display session if one exists.
                      </span>
                    </div>
                  </div>
                </section>

                {/* Active Token Hero */}
                <section className="card">
                  <div className="qr-hero">
                    <div className="row between wrap">
                      <div>
                        <h3 style={{marginBottom: '4px'}}>Active Token</h3>
                        <div className="row gap wrap" style={{ alignItems: 'center' }}>
                          <span className={`pill ${activeToken?.active ? 'ok' : 'warning'}`}>
                            {activeToken?.active ? 'Active' : 'No active token'}
                          </span>
                          {activeToken?.active ? (
                            <span className="muted">Expires in {formatSeconds(activeTokenSecondsLeft)}</span>
                          ) : null}
                        </div>
                        {activeToken?.active ? (
                          <p className="muted" style={{ margin: '6px 0 0' }}>
                            Expires at {formatClock(activeToken.expiresAt)} • Source: {formatTokenSource(activeToken)}
                          </p>
                        ) : null}
                      </div>
                      <div style={{fontFamily: 'monospace', fontSize: '14px'}}>
                        Scans Active: {tokenHistory.filter((t) => t.active && t.scansCount > 0).reduce((sum, t) => sum + (t.scansCount || 0), 0)}
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
                          <code
                            title={activeToken.token}
                            style={{fontSize: '20px', letterSpacing: '2px', background: 'var(--paper2)', padding: '12px 20px', borderRadius: '8px', display: 'inline-block', cursor: 'help'}}
                          >
                            {activeToken.token}
                          </code>
                        </div>
                        <div className="row gap" style={{justifyContent: 'center', marginTop: '16px'}}>
                          <button className="ghost" onClick={copyToken}>Copy Token</button>
                          <button className="ghost" onClick={() => {
                            const a = document.createElement('a')
                            a.href = buildQrUrl(activeToken.token)
                            a.download = `scantrack-qr-${activeToken.token}.png`
                            a.click()
                          }}>Download PNG</button>
                          <button className="ghost" onClick={() => {
                            const url = `${window.location.origin}/employee?t=${activeToken.token}`
                            navigator.clipboard.writeText(url).then(() => setMessage('Token URL copied to clipboard.')).catch(() => setError('Clipboard copy not available.'))
                          }}>Copy URL</button>
                        </div>
                        {activeTvSession?.launchUrl ? (
                          <div className="row gap" style={{ justifyContent: 'center', marginTop: '12px' }}>
                            <button className="ghost" onClick={() => window.open(activeTvSession.launchUrl, '_blank')}>
                              Preview TV Screen
                            </button>
                            <button className="ghost" onClick={launchTvDisplay}>
                              Refresh TV Session
                            </button>
                          </div>
                        ) : null}
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
                    <label>
                      <strong>Expiry</strong>
                      <select value={tokenExpiryFilter} onChange={(e) => setTokenExpiryFilter(e.target.value)}>
                        <option value="all">All</option>
                        <option value="expiresSoon">Expiring soon</option>
                        <option value="longerThanHour">Active &gt;1h</option>
                      </select>
                    </label>
                  </div>
                </section>

                {/* Token History Table */}
                <section className="card">
                  <h3>Token History <span className="muted" style={{fontSize: '14px'}}>({filteredTokens.length})</span></h3>
                  <DataTable
                    data={filteredTokens}
                    columns={[
                      {
                        key: 'token',
                        header: 'Token ID',
                        render: (token) => <code title={token.token}>{token.token.slice(0, 12)}...</code>,
                        sortable: true,
                      },
                      {
                        key: 'status',
                        header: 'Status',
                        render: (token) => (
                          <span className={`pill ${token.active ? 'ok' : 'danger'}`}>
                            {token.active ? 'Active' : 'Expired'}
                          </span>
                        ),
                        sortable: true,
                      },
                      {
                        key: 'source',
                        header: 'Source',
                        render: (token) => formatTokenSource(token),
                        sortable: true,
                      },
                      {
                        key: 'scansCount',
                        header: 'Scans',
                        render: (token) => <strong>{token.scansCount || 0}</strong>,
                        sortable: true,
                      },
                      {
                        key: 'issuedAt',
                        header: 'Issued',
                        render: (token) => formatClock(token.issuedAt),
                        sortable: true,
                      },
                      {
                        key: 'expiresAt',
                        header: 'Expires',
                        render: (token) => formatRelative(token.expiresAt),
                        sortable: true,
                      },
                      {
                        key: 'actions',
                        header: 'Actions',
                        render: (token) => (
                          <div className="row gap">
                            <button className="ghost btn-sm" onClick={() => handleCopyToken(token.token)}>Copy</button>
                            {token.active ? (
                              <button className="ghost btn-sm warning" onClick={() => handleRevokeToken(token.token)}>Revoke</button>
                            ) : (
                              <button className="ghost btn-sm danger" onClick={() => handleDeleteToken(token.token)}>Delete</button>
                            )}
                          </div>
                        ),
                        sortable: false,
                      },
                    ]}
                    searchable={false}
                    paginated={false}
                    emptyMessage="No tokens found. Generate one to begin."
                    className="token-history-table"
                  />
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
                        <DatePicker
                          value={attendanceRangeStart}
                          onChange={setAttendanceRangeStart}
                          placeholder="Start date"
                        />
                      </label>
                      <label>
                        <span className="muted">To</span>
                        <DatePicker
                          value={attendanceRangeEnd}
                          onChange={setAttendanceRangeEnd}
                          placeholder="End date"
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
                <label>Date
                  <DatePicker
                    value={date}
                    onChange={(newDate) => {
                      setDateTouched(true)
                      setDate(newDate)
                    }}
                    placeholder="Select date"
                  />
                </label>
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
          <div className="settings-page">
            <section className="card admin-top-row settings-hero">
              <div className="settings-hero-copy">
                <p className="eyebrow">System Settings</p>
                <h1>Attendance, payroll, and location rules</h1>
                <p className="muted" style={{ margin: '6px 0 0' }}>
                  Manage work hours, GPS verification, payroll defaults, tax behavior, and weekly schedule rules from one place.
                </p>
                <div className="settings-kpis">
                  <article>
                    <span>Default day</span>
                    <strong>{settings.workStart} - {settings.workEnd}</strong>
                  </article>
                  <article>
                    <span>Grace period</span>
                    <strong>{Number(settings.graceMins || 0)} min</strong>
                  </article>
                  <article>
                    <span>GPS radius</span>
                    <strong>{Number(gpsRadius || 0)} m</strong>
                  </article>
                  <article>
                    <span>Expected workdays</span>
                    <strong>{Number(settings.payrollRules?.expectedWorkDays ?? 26)}</strong>
                  </article>
                </div>
              </div>
              <div className="settings-hero-actions">
                <button onClick={saveSettings} disabled={savingSettings}>
                  {savingSettings ? 'Saving...' : 'Save Changes'}
                </button>
                <p className="muted" style={{ margin: 0 }}>
                  Review schedule, payroll, and GPS settings before saving.
                </p>
              </div>
            </section>

            <section className="settings-overview-grid">
              <article className="card settings-panel">
                <div className="settings-card-head">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Default Work Hours</h3>
                    <p className="muted" style={{ margin: 0 }}>Used as fallback when a day does not override the default schedule.</p>
                  </div>
                </div>
                <div className="settings-field-grid">
                  <label>Work Start Time<input type="time" value={settings.workStart} onChange={(e) => setSettings((old) => ({ ...old, workStart: e.target.value }))} /></label>
                  <label>Work End Time<input type="time" value={settings.workEnd} onChange={(e) => setSettings((old) => ({ ...old, workEnd: e.target.value }))} /></label>
                  <label>Grace Period (minutes)<input type="number" min="0" value={settings.graceMins} onChange={(e) => setSettings((old) => ({ ...old, graceMins: Number(e.target.value) }))} /></label>
                </div>
              </article>

              <article className="card settings-panel">
                <div className="settings-card-head">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Notifications & Rules</h3>
                    <p className="muted" style={{ margin: 0 }}>Enable attendance safeguards and employee-facing preferences.</p>
                  </div>
                </div>
                <div className="settings-toggles settings-toggles-spacious">
                  <label className="toggle-row"><span>Late Arrival Alerts</span><input type="checkbox" checked={settings.lateAlerts} onChange={(e) => setSettings((old) => ({ ...old, lateAlerts: e.target.checked }))} /></label>
                  <label className="toggle-row"><span>GPS Verification</span><input type="checkbox" checked={settings.gpsVerify} onChange={(e) => setSettings((old) => ({ ...old, gpsVerify: e.target.checked }))} /></label>
                  <label className="toggle-row"><span>Duplicate Prevention</span><input type="checkbox" checked={settings.dupePrevention} onChange={(e) => setSettings((old) => ({ ...old, dupePrevention: e.target.checked }))} /></label>
                  <label className="toggle-row"><span>Employee Dark Mode</span><input type="checkbox" checked={settings.employeeDarkMode} onChange={(e) => setSettings((old) => ({ ...old, employeeDarkMode: e.target.checked }))} /></label>
                </div>
              </article>
            </section>

            <section className="card settings-panel settings-schedule-card">
              <div className="row between wrap settings-card-head" style={{ marginBottom: 10 }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>Weekly Schedule</h3>
                  <p className="muted" style={{ margin: 0 }}>Set different work hours per day and decide if check-in / check-out is allowed.</p>
                </div>
                <div className="row gap wrap settings-schedule-actions">
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
                <DataTable
                  data={WEEK}
                  columns={[
                    {
                      key: 'day',
                      header: 'Day',
                      render: (day) => <strong>{day.label}</strong>,
                      sortable: true,
                    },
                    {
                      key: 'enabled',
                      header: 'Enabled',
                      render: (day) => {
                        const rule = settings.weeklySchedule?.[day.key] || {}
                        const enabled = rule.enabled !== false
                        return (
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
                        )
                      },
                      sortable: false,
                    },
                    {
                      key: 'workStart',
                      header: 'Start',
                      render: (day) => {
                        const rule = settings.weeklySchedule?.[day.key] || {}
                        const enabled = rule.enabled !== false
                        return (
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
                        )
                      },
                      sortable: false,
                    },
                    {
                      key: 'workEnd',
                      header: 'End',
                      render: (day) => {
                        const rule = settings.weeklySchedule?.[day.key] || {}
                        const enabled = rule.enabled !== false
                        return (
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
                        )
                      },
                      sortable: false,
                    },
                    {
                      key: 'graceMins',
                      header: 'Grace',
                      render: (day) => {
                        const rule = settings.weeklySchedule?.[day.key] || {}
                        const enabled = rule.enabled !== false
                        return (
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
                        )
                      },
                      sortable: false,
                    },
                    {
                      key: 'allowCheckIn',
                      header: 'Check In',
                      render: (day) => {
                        const rule = settings.weeklySchedule?.[day.key] || {}
                        const enabled = rule.enabled !== false
                        return (
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
                        )
                      },
                      sortable: false,
                    },
                    {
                      key: 'allowCheckOut',
                      header: 'Check Out',
                      render: (day) => {
                        const rule = settings.weeklySchedule?.[day.key] || {}
                        const enabled = rule.enabled !== false
                        return (
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
                        )
                      },
                      sortable: false,
                    },
                  ]}
                  searchable={false}
                  paginated={false}
                  emptyMessage="No schedule rows available."
                  className="schedule-table"
                />
              </div>

              <p className="muted settings-helper" style={{ margin: '10px 0 0' }}>
                Disabled days block employee scans and prevent late alerts. You can also disable only check-in or only check-out.
              </p>
            </section>

            <section className="settings-overview-grid">
              <article className="card settings-panel">
                <div className="settings-card-head">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Payroll Rules</h3>
                    <p className="muted" style={{ margin: 0 }}>Configure default salary behavior, leave handling, and overtime calculations.</p>
                  </div>
                </div>
                <div className="settings-field-grid">
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
                  <label>Default housing allowance
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.housingAllowanceDefault ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), housingAllowanceDefault: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Default transport allowance
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.transportAllowanceDefault ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), transportAllowanceDefault: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Default medical allowance
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.medicalAllowanceDefault ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), medicalAllowanceDefault: Number(e.target.value) },
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
                <p className="muted settings-helper" style={{ margin: '10px 0 0' }}>
                  Example: `0.5` means each late day deducts half a day rate.
                </p>
                <p className="muted settings-helper" style={{ margin: '8px 0 0' }}>
                  Overtime applies after the scheduled end time, with a seasonal rate for Christmas and New Year if configured.
                </p>
              </article>

              <article className="card settings-panel">
                <div className="settings-card-head">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Bonuses, Tax & Integrations</h3>
                    <p className="muted" style={{ margin: 0 }}>Control fixed bonuses, tax defaults, and attendance or leave data sources.</p>
                  </div>
                </div>
                <div className="settings-field-grid">
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
                  <label className="toggle-row">
                    <span>Enable default tax deduction</span>
                    <input
                      type="checkbox"
                      checked={settings.payrollRules?.taxEnabled === true}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), taxEnabled: e.target.checked },
                        }))
                      }
                    />
                  </label>
                  <label>Tax Label
                    <input
                      value={settings.payrollRules?.taxLabel ?? 'PAYE'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), taxLabel: e.target.value },
                        }))
                      }
                    />
                  </label>
                  <label>Tax Mode
                    <select
                      value={settings.payrollRules?.taxMode ?? 'percent'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), taxMode: e.target.value },
                        }))
                      }
                    >
                      <option value="percent">Percentage</option>
                      <option value="fixed">Fixed Amount</option>
                    </select>
                  </label>
                  <label>Default Tax Percent
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={settings.payrollRules?.taxPercent ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), taxPercent: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Default Fixed Tax
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.taxFixed ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), taxFixed: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Default Tax Relief
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={settings.payrollRules?.taxRelief ?? 0}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), taxRelief: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                  <label>Attendance Integration
                    <select
                      value={settings.payrollRules?.attendanceIntegrationMode ?? 'manual'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), attendanceIntegrationMode: e.target.value },
                        }))
                      }
                    >
                      <option value="manual">Manual Entry</option>
                      <option value="biometric">Biometric Device</option>
                      <option value="integrated">External API / Import</option>
                    </select>
                  </label>
                  <label>Leave Integration
                    <select
                      value={settings.payrollRules?.leaveIntegrationMode ?? 'manual'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), leaveIntegrationMode: e.target.value },
                        }))
                      }
                    >
                      <option value="manual">Manual Entry</option>
                      <option value="hris">HRIS / Leave Module</option>
                      <option value="integrated">External API / Import</option>
                    </select>
                  </label>
                  <label>Payslip Delivery
                    <select
                      value={settings.payrollRules?.payslipDeliveryMode ?? 'portal_pdf'}
                      onChange={(e) =>
                        setSettings((old) => ({
                          ...old,
                          payrollRules: { ...(old.payrollRules || {}), payslipDeliveryMode: e.target.value },
                        }))
                      }
                    >
                      <option value="portal_pdf">Portal + PDF</option>
                      <option value="email_pdf">Email PDF</option>
                      <option value="portal_only">Portal Only</option>
                    </select>
                  </label>
                </div>
                <p className="muted settings-helper" style={{ margin: '10px 0 0' }}>
                  Attendance bonuses, tax defaults, and integration metadata apply when salary is generated for the month.
                </p>
              </article>
            </section>

            <section className="settings-overview-grid">
              <article className="card settings-panel settings-gps-panel">
                <div className="settings-card-head">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Shop GPS Location</h3>
                    <p className="muted" style={{ margin: 0 }}>Set the verification point and service radius used for location-based attendance checks.</p>
                  </div>
                </div>
                <div className="settings-gps-grid">
                  <label>Latitude<input type="number" step="any" value={gpsLat} onChange={(e) => {
                    setGpsLat(Number(e.target.value))
                  }} /></label>
                  <label>Longitude<input type="number" step="any" value={gpsLng} onChange={(e) => {
                    setGpsLng(Number(e.target.value))
                  }} /></label>
                  <label className="settings-field-wide">Verification Radius (m)<input type="range" min="50" max="500" value={gpsRadius} onChange={(e) => setGpsRadius(Number(e.target.value))} /><span>{gpsRadius}m</span></label>
                </div>
                <div className="settings-map-wrap">
                  <MapPicker
                    lat={gpsLat}
                    lng={gpsLng}
                    radius={gpsRadius}
                    onLocationSelect={(newLat, newLng) => {
                      setGpsLat(newLat)
                      setGpsLng(newLng)
                    }}
                    className="map-preview"
                  />
                </div>
                <div className="row gap wrap settings-gps-actions">
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
                <p className="muted settings-helper" style={{ marginTop: '8px' }}>Map preview updates instantly. Save to apply for GPS verification.</p>
              </article>

              <article className="card settings-panel settings-save-panel">
                <div className="settings-card-head">
                  <div>
                    <h3 style={{ marginBottom: 4 }}>Review & Save</h3>
                    <p className="muted" style={{ margin: 0 }}>Save after reviewing schedule, payroll defaults, and GPS verification behavior.</p>
                  </div>
                </div>
                <div className="settings-save-summary">
                  <p><span>Default Hours</span><strong>{settings.workStart} - {settings.workEnd}</strong></p>
                  <p><span>GPS Verification</span><strong>{settings.gpsVerify ? 'Enabled' : 'Disabled'}</strong></p>
                  <p><span>Tax Default</span><strong>{settings.payrollRules?.taxEnabled ? 'Enabled' : 'Disabled'}</strong></p>
                  <p><span>Payslip Delivery</span><strong>{settings.payrollRules?.payslipDeliveryMode || 'portal_pdf'}</strong></p>
                </div>
                <button onClick={saveSettings} disabled={savingSettings}>{savingSettings ? 'Saving...' : 'Save Changes'}</button>
              </article>
            </section>
          </div>
        )}

        {employeeDetail ? (
          <section
            className="card modal-overlay"
            onClick={(event) => event.target === event.currentTarget && closeEmployeeDetail()}
          >
            <article className="card employee-detail-drawer">
              {(() => {
                const detailSalary = employeeDetailSalaryRows.find((row) => row.userId === employeeDetail.uid && row.month === employeeDetailMonth) || null
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
                const absent = daysInMonth - summary.present
                const salarySummary = employeeDetailSalaryRows.reduce(
                  (acc, row) => ({
                    months: acc.months + 1,
                    totalFinal: acc.totalFinal + Number(row.finalSalary || 0),
                    totalBase: acc.totalBase + Number(row.baseSalary || 0),
                    totalDeductions: acc.totalDeductions + Number(row.deductions || 0),
                    totalBonus: acc.totalBonus + Number(row.bonus || 0),
                    totalPresent: acc.totalPresent + Number(row.daysPresent || 0),
                    totalLate: acc.totalLate + Number(row.lateDays || 0),
                    totalOvertimeHours: acc.totalOvertimeHours + Number(row.overtimeHours || 0),
                  }),
                  {
                    months: 0,
                    totalFinal: 0,
                    totalBase: 0,
                    totalDeductions: 0,
                    totalBonus: 0,
                    totalPresent: 0,
                    totalLate: 0,
                    totalOvertimeHours: 0,
                  },
                )
                return (
                  <>
                    <div className="row between wrap employee-detail-head">
                      <div>
                        <p className="eyebrow">Employee Detail</p>
                        <h2 style={{ marginBottom: 4 }}>{employeeDetail.name || employeeDetail.email}</h2>
                        <p className="muted" style={{ margin: 0 }}>{employeeDetail.email}</p>
                      </div>
                      <div className="row gap wrap">
                        <button
                          type="button"
                          className="ghost btn-sm"
                          onClick={() => setEmployeeDetailView('month')}
                        >
                          Month view
                        </button>
                        <button
                          type="button"
                          className="ghost btn-sm"
                          onClick={() => setEmployeeDetailView('history')}
                        >
                          Full history
                        </button>
                        <button
                          type="button"
                          className="ghost btn-sm"
                          onClick={openEmployeeAttendance}
                        >
                          Open attendance
                        </button>
                        <button
                          type="button"
                          className="ghost btn-sm"
                          onClick={openEmployeeSalary}
                        >
                          Open salary
                        </button>
                        <button
                          type="button"
                          className="ghost btn-sm"
                          onClick={exportEmployeeRecords}
                          disabled={!employeeDetailRows.length && !employeeDetailSalaryRows.length}
                        >
                          Export records
                        </button>
                      </div>
                    </div>

                    <section className="salary-selected-summary">
                      <article className="card salary-summary-card">
                        <h3>Profile</h3>
                        <div className="grid two compact">
                          <p><strong>Employee ID:</strong> {employeeDetail.employeeCode || '-'}</p>
                          <p><strong>Role:</strong> {employeeDetail.role || 'employee'}</p>
                          <p><strong>Payroll Role:</strong> {employeeDetail.roleName || 'None'}</p>
                          <p><strong>Grade:</strong> {employeeDetail.grade || '-'}</p>
                          <p><strong>Employment Type:</strong> {employeeDetail.employmentType || '-'}</p>
                          <p><strong>Status:</strong> {employeeDetail.status || 'active'}</p>
                          <p><strong>Department:</strong> {employeeDetail.department || '-'}</p>
                          <p><strong>Attendance Source:</strong> {employeeDetail.attendanceSource || settings.payrollRules?.attendanceIntegrationMode || 'manual'}</p>
                          <p><strong>Phone:</strong> {employeeDetail.phone || '-'}</p>
                          <p><strong>Join Date:</strong> {employeeDetail.joinDate ? new Date(employeeDetail.joinDate).toLocaleDateString() : '-'}</p>
                          <p><strong>Daily Rate:</strong> {Number(employeeDetail.dailyRate || 0).toLocaleString()}</p>
                          <p><strong>Paid Holidays:</strong> {Number(employeeDetail.allowedHolidays ?? settings.payrollRules?.defaultAllowedHolidays ?? 1)}</p>
                          <p><strong>Bank:</strong> {employeeDetail.bankName || '-'}</p>
                          <p><strong>Account:</strong> {employeeDetail.bankAccountNo || '-'}</p>
                          <p><strong>{employeeDetail.taxLabel || settings.payrollRules?.taxLabel || 'Tax'} No:</strong> {employeeDetail.taxNumber || '-'}</p>
                          <p><strong>Loan Installment:</strong> {Number(employeeDetail.loanInstallment || 0).toLocaleString()}</p>
                          <p><strong>Advance Recovery:</strong> {Number(employeeDetail.advanceInstallment || 0).toLocaleString()}</p>
                          <p><strong>Attendance Days:</strong> {employeeDetailRows.length}</p>
                          {employeeDetail.address && <p><strong>Address:</strong> {employeeDetail.address}</p>}
                          {employeeDetail.notes && <p><strong>Notes:</strong> {employeeDetail.notes}</p>}
                        </div>
                      </article>
                      <article className="card salary-summary-card">
                        <h3>Month Summary</h3>
                        <div className="grid two compact">
                          <p><strong>Present:</strong> {summary.present}</p>
                          <p><strong>Absent:</strong> {absent}</p>
                          <p><strong>Late:</strong> {summary.late}</p>
                          <p><strong>OT Days:</strong> {summary.overtime}</p>
                          <p><strong>OT Minutes:</strong> {summary.overtimeMinutes}</p>
                          <p><strong>Salary Record:</strong> {detailSalary ? 'Available' : 'Not generated'}</p>
                          <p><strong>Month:</strong> {employeeDetailMonth}</p>
                          <p><strong>Allowances:</strong> {Number(detailSalary?.allowancesTotal || 0).toLocaleString()}</p>
                          <p><strong>Incentives:</strong> {Number(detailSalary?.incentivePay || 0).toLocaleString()}</p>
                          <p><strong>{detailSalary?.taxLabel || settings.payrollRules?.taxLabel || 'Tax'}:</strong> {Number(detailSalary?.taxDeduction || 0).toLocaleString()}</p>
                          <p><strong>Final Salary:</strong> {Number(detailSalary?.finalSalary || 0).toLocaleString()}</p>
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
                          <div className="row gap">
                            <button
                              type="button"
                              className={`ghost btn-sm ${bulkMode ? 'active' : ''}`}
                              onClick={() => setBulkMode(!bulkMode)}
                            >
                              {bulkMode ? 'Exit Bulk' : 'Bulk Edit'}
                            </button>
                            <label style={{ minWidth: 180 }}>
                              <input
                                type="month"
                                value={employeeDetailMonth}
                                onChange={(event) => {
                                  setEmployeeDetailMonth(event.target.value)
                                  setEmployeeDetailDateKey('')
                                  setSelectedDays(new Set())
                                }}
                              />
                            </label>
                          </div>
                        </div>

                        {bulkMode && selectedDays.size > 0 && (
                          <div className="bulk-actions row gap" style={{ marginBottom: 8, padding: 8, background: 'var(--paper2)', borderRadius: 8 }}>
                            <span>{selectedDays.size} day(s) selected</span>
                            <button
                              type="button"
                              className="ghost btn-sm"
                              onClick={() => bulkUpdateAttendance('absent')}
                              disabled={savingAttendanceUpdate}
                            >
                              Mark Absent
                            </button>
                            <button
                              type="button"
                              className="danger btn-sm"
                              onClick={() => bulkDeleteAttendance()}
                              disabled={savingAttendanceUpdate}
                            >
                              Delete Selected
                            </button>
                          </div>
                        )}

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
                            const schedule = getScheduleForDate(dayKey, settings)
                            const status = row
                              ? row.checkInAt
                                ? row.checkOutAt
                                  ? 'present'
                                  : 'open'
                                : 'absent'
                              : schedule.enabled
                                ? 'absent'
                                : 'dayoff'
                            const statusLabel = row ? (row.checkInAt ? 'Present' : 'Absent') : (schedule.enabled ? 'Absent' : 'Day off')
                            const overtimeHours = Math.round((Number(row?.overtimeMinutes || 0) / 60) * 100) / 100
                            return (
                              <div
                                key={dayKey}
                                className={`calendar-cell ${status} ${selectedDateKey === dayKey ? 'selected' : ''}`}
                              >
                                {bulkMode && (
                                  <input
                                    type="checkbox"
                                    checked={selectedDays.has(dayKey)}
                                    onChange={(e) => {
                                      const newSelected = new Set(selectedDays)
                                      if (e.target.checked) {
                                        newSelected.add(dayKey)
                                      } else {
                                        newSelected.delete(dayKey)
                                      }
                                      setSelectedDays(newSelected)
                                    }}
                                    style={{ position: 'absolute', top: 4, right: 4 }}
                                  />
                                )}
                                <button
                                  type="button"
                                  className="calendar-cell-button"
                                  onClick={() => !bulkMode && setEmployeeDetailDateKey(dayKey)}
                                  disabled={bulkMode}
                                >
                                  <span className="calendar-day">{day}</span>
                                  <span className="calendar-status">{statusLabel}</span>
                                  <span className="calendar-time">{row?.checkInAt ? formatClock(row.checkInAt) : 'No check-in'}</span>
                                  <span className="calendar-overtime" title="Overtime hours worked beyond standard shift duration">{overtimeHours > 0 ? `${overtimeHours}h OT` : status === 'absent' ? 'Missing' : status === 'dayoff' ? 'Day off' : 'No OT'}</span>
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </article>

                      <article className="card salary-day-detail selected-day-card">
                        <div className="salary-day-detail-header">
                          <div>
                            <h3 style={{ marginBottom: 4 }}>Selected Day</h3>
                            {(() => {
                              const selectedSchedule = getScheduleForDate(selectedDateKey, settings)
                              const selectedStatusLabel = selectedDay
                                ? selectedDay.checkInAt
                                  ? selectedDay.checkOutAt
                                    ? 'Present'
                                    : 'Open shift'
                                  : selectedSchedule.enabled
                                    ? 'Absent'
                                    : 'Day off'
                                : selectedSchedule.enabled
                                  ? 'Absent'
                                  : 'Day off'
                              return (
                                <p className="muted" style={{ marginTop: 0 }}>
                                  {selectedDateKey} • {selectedStatusLabel}
                                </p>
                              )
                            })()}
                          </div>
                          <span className="status-pill">{selectedDay?.checkInAt ? 'Present' : selectedDay?.checkOutAt ? 'Open' : 'Absent'}</span>
                        </div>
                        <div className="salary-day-summary-grid">
                          <div>
                            <p className="detail-label">Check In</p>
                            <p>{selectedDay?.checkInAt ? formatClock(selectedDay.checkInAt) : '-'}</p>
                          </div>
                          <div>
                            <p className="detail-label">Check Out</p>
                            <p>{selectedDay?.checkOutAt ? formatClock(selectedDay.checkOutAt) : '-'}</p>
                          </div>
                          <div>
                            <p className="detail-label">Worked</p>
                            <p>{formatDurationMs(Number(selectedDay?.workedMinutes || 0) * 60000)}</p>
                          </div>
                          <div>
                            <p className="detail-label">OT</p>
                            <p title="Overtime hours calculated based on shift duration and payroll rules">{Math.round((Number(selectedDay?.overtimeMinutes || 0) / 60) * 100) / 100}h</p>
                          </div>
                          <div>
                            <p className="detail-label">OT Pay</p>
                            <p title="Overtime pay calculated using configured multiplier and rate">{Number(selectedDay?.overtimePay || 0).toLocaleString()}</p>
                          </div>
                          <div>
                            <p className="detail-label">Season</p>
                            <p title="Overtime season label (e.g., holiday, weekend)">{selectedDay?.overtimeLabel || '-'}</p>
                          </div>
                        </div>
                        <div className="salary-history-section">
                          <h3>Salary history</h3>
                          {employeeDetailSalaryRows.length ? (
                            <DataTable
                              data={employeeDetailSalaryRows}
                              columns={[
                                {
                                  key: 'month',
                                  header: 'Month',
                                  sortable: true,
                                },
                                {
                                  key: 'finalSalary',
                                  header: 'Final',
                                  render: (row) => Number(row.finalSalary || 0).toLocaleString(),
                                  sortable: true,
                                },
                                {
                                  key: 'daysPresent',
                                  header: 'Present',
                                  render: (row) => row.daysPresent || 0,
                                  sortable: true,
                                },
                                {
                                  key: 'lateDays',
                                  header: 'Late',
                                  render: (row) => row.lateDays || 0,
                                  sortable: true,
                                },
                                {
                                  key: 'overtimeHours',
                                  header: 'OT Hrs',
                                  render: (row) => Math.round(Number(row.overtimeHours || 0) * 100) / 100,
                                  sortable: true,
                                },
                                {
                                  key: 'baseSalary',
                                  header: 'Base',
                                  render: (row) => Number(row.baseSalary || 0).toLocaleString(),
                                  sortable: true,
                                },
                                {
                                  key: 'deductions',
                                  header: 'Deductions',
                                  render: (row) => Number(row.deductions || 0).toLocaleString(),
                                  sortable: true,
                                },
                                {
                                  key: 'bonus',
                                  header: 'Bonus',
                                  render: (row) => Number(row.bonus || 0).toLocaleString(),
                                  sortable: true,
                                },
                              ]}
                              searchable={false}
                              paginated={false}
                              emptyMessage="No recent salary record history available for this employee."
                              className="employee-salary-history-table"
                            />
                          ) : (
                            <p className="muted">No recent salary record history available for this employee.</p>
                          )}
                        </div>
                        <article className="card attendance-edit-card" style={{ marginTop: 16 }}>
                          <div className="attendance-edit-header">
                            <h3>Edit attendance</h3>
                            <label className="attendance-absent-toggle" title="Mark this day as absent, clearing check-in/out times">
                              <input
                                type="checkbox"
                                checked={markAbsent}
                                onChange={(event) => setMarkAbsent(event.target.checked)}
                              />
                              <span>Mark absent</span>
                            </label>
                          </div>
                          <div className="attendance-edit-grid">
                            <label className="attendance-edit-field">
                              <span>Check-in time</span>
                              <input
                                type="time"
                                value={dayCheckInTime}
                                onChange={(event) => setDayCheckInTime(event.target.value)}
                                disabled={markAbsent || employeeDetailLoading}
                              />
                            </label>
                            <label className="attendance-edit-field">
                              <span>Check-out time</span>
                              <input
                                type="time"
                                value={dayCheckOutTime}
                                onChange={(event) => setDayCheckOutTime(event.target.value)}
                                disabled={markAbsent || employeeDetailLoading}
                              />
                            </label>
                          </div>
                          <div className="attendance-edit-actions row gap">
                            <button
                              type="button"
                              className="ghost btn-sm"
                              onClick={clearEmployeeAttendanceForDay}
                              disabled={employeeDetailLoading || savingAttendanceUpdate}
                            >
                              Clear times
                            </button>
                            <button
                              type="button"
                              className="primary btn-sm"
                              onClick={saveEmployeeAttendanceUpdate}
                              disabled={employeeDetailLoading || savingAttendanceUpdate}
                            >
                              {savingAttendanceUpdate ? 'Saving...' : 'Save changes'}
                            </button>
                            <button
                              type="button"
                              className="danger btn-sm"
                              onClick={deleteEmployeeAttendanceForDay}
                              disabled={employeeDetailLoading || savingAttendanceUpdate || !selectedDay}
                            >
                              Delete day
                            </button>
                          </div>
                          <p className="muted attendance-edit-note">
                            Clear both times to mark the day absent. Use check-in time alone for an open shift.
                          </p>
                        </article>
                        {employeeDetailView === 'history' ? (
                          <article className="card salary-history-card">
                            <div className="row between wrap" style={{ marginBottom: 10 }}>
                              <div>
                                <h3 style={{ marginBottom: 4 }}>Full employee history</h3>
                                <p className="muted" style={{ margin: 0 }}>
                                  Showing {employeeDetailSalaryRows.length} salary month(s) and current attendance details.
                                </p>
                              </div>
                              <button
                                type="button"
                                className="ghost btn-sm"
                                onClick={exportEmployeeRecords}
                                disabled={!employeeDetailSalaryRows.length && !employeeDetailRows.length}
                              >
                                Export all records
                              </button>
                            </div>
                            <div className="grid three compact" style={{ gap: '10px' }}>
                              <p><strong>Months loaded:</strong> {salarySummary.months}</p>
                              <p><strong>Total final:</strong> {salarySummary.totalFinal.toLocaleString()}</p>
                              <p><strong>Total base:</strong> {salarySummary.totalBase.toLocaleString()}</p>
                              <p><strong>Total deductions:</strong> {salarySummary.totalDeductions.toLocaleString()}</p>
                              <p><strong>Total bonus:</strong> {salarySummary.totalBonus.toLocaleString()}</p>
                              <p><strong>Total OT hrs:</strong> {Math.round(salarySummary.totalOvertimeHours * 100) / 100}</p>
                            </div>
                            {employeeDetailSalaryRows.length ? (
                              <DataTable
                                data={employeeDetailSalaryRows}
                                columns={[
                                  {
                                    key: 'month',
                                    header: 'Month',
                                    sortable: true,
                                  },
                                  {
                                    key: 'finalSalary',
                                    header: 'Final',
                                    render: (row) => Number(row.finalSalary || 0).toLocaleString(),
                                    sortable: true,
                                  },
                                  {
                                    key: 'baseSalary',
                                    header: 'Base',
                                    render: (row) => Number(row.baseSalary || 0).toLocaleString(),
                                    sortable: true,
                                  },
                                  {
                                    key: 'deductions',
                                    header: 'Deductions',
                                    render: (row) => Number(row.deductions || 0).toLocaleString(),
                                    sortable: true,
                                  },
                                  {
                                    key: 'bonus',
                                    header: 'Bonus',
                                    render: (row) => Number(row.bonus || 0).toLocaleString(),
                                    sortable: true,
                                  },
                                  {
                                    key: 'daysPresent',
                                    header: 'Present',
                                    render: (row) => row.daysPresent || 0,
                                    sortable: true,
                                  },
                                  {
                                    key: 'lateDays',
                                    header: 'Late',
                                    render: (row) => row.lateDays || 0,
                                    sortable: true,
                                  },
                                  {
                                    key: 'overtimeHours',
                                    header: 'OT Hrs',
                                    render: (row) => Math.round(Number(row.overtimeHours || 0) * 100) / 100,
                                    sortable: true,
                                  },
                                ]}
                                searchable={false}
                                paginated={false}
                                emptyMessage="No salary records available."
                                className="employee-detail-salary-history-table"
                              />
                            ) : null}
                          </article>
                        ) : null}
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

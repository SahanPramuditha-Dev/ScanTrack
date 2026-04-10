import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { APP_CONFIG } from '../config'
import { auth, db, functions as cloudFunctions, googleProvider, isFirebaseConfigured } from '../lib/firebase'
import { createToken, getTodayKey, humanTime, now } from '../lib/time'

const DEMO_USERS_KEY = 'scantrack_demo_users'
const DEMO_LOGS_KEY = 'scantrack_demo_logs'
const DEMO_TV_KEY = 'scantrack_demo_tv_token'
const DEMO_TOKENS_KEY = 'scantrack_demo_tokens'
const DEMO_TV_SESSIONS_KEY = 'scantrack_demo_tv_sessions'
const DEMO_SETTINGS_KEY = 'scantrack_demo_settings'
const DEMO_SESSION_KEY = 'scantrack_demo_session'
const TV_DISPLAY_SESSION_KEY = 'scantrack_tv_display_session'
const AUTH_ERROR_KEY = 'scantrack_auth_error'

const DEFAULT_SETTINGS = {
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
    latePenaltyFraction: 0.5, // dailyRate * fraction per late day
    perfectAttendanceBonus: 0, // fixed amount
    noLateBonus: 0, // fixed amount
    overtimeEnabled: true,
    overtimeThresholdMins: 0,
    overtimeMultiplier: 1.5,
    seasonalOvertimeMultiplier: 2,
    seasonalOvertimeStart: '12-15',
    seasonalOvertimeEnd: '01-10',
  },
}

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DEMO_SALARY_KEY = 'scantrack_demo_salary_records'
const DEMO_DAILY_PAYMENTS_KEY = 'scantrack_demo_daily_payments'
const MIN_TOKEN_REFRESH_SECONDS = 60

const DEDUCTION_TYPES = ['advance', 'fine', 'loan', 'other'];

function normalizeRefreshIntervalSeconds(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return MIN_TOKEN_REFRESH_SECONDS
  return Math.max(MIN_TOKEN_REFRESH_SECONDS, Math.round(parsed))
}

function formatDateKeyForTimezone(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function getWeekdayKeyFromDateKey(dateKey) {
  // Use a stable midday UTC anchor to avoid timezone rollover edge cases.
  const anchor = new Date(`${dateKey}T12:00:00.000Z`)
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: APP_CONFIG.timezone })
    .format(anchor)
    .toLowerCase()
  if (weekday.startsWith('mon')) return 'mon'
  if (weekday.startsWith('tue')) return 'tue'
  if (weekday.startsWith('wed')) return 'wed'
  if (weekday.startsWith('thu')) return 'thu'
  if (weekday.startsWith('fri')) return 'fri'
  if (weekday.startsWith('sat')) return 'sat'
  return 'sun'
}

function normalizeWeeklySchedule(settings) {
  const base = DEFAULT_SETTINGS.weeklySchedule
  const provided = settings?.weeklySchedule && typeof settings.weeklySchedule === 'object' ? settings.weeklySchedule : {}
  const merged = {}
  for (const key of WEEKDAY_KEYS) {
    merged[key] = {
      ...base[key],
      ...(provided[key] || {}),
    }
  }
  return merged
}

export function getScheduleForDate(dateKey, settings) {
  const weeklySchedule = normalizeWeeklySchedule(settings)
  const weekdayKey = dateKey ? getWeekdayKeyFromDateKey(dateKey) : WEEKDAY_KEYS[new Date().getDay()]
  const dayRule = weeklySchedule[weekdayKey] || DEFAULT_SETTINGS.weeklySchedule[weekdayKey]
  return {
    weekdayKey,
    enabled: dayRule.enabled !== false,
    workStart: String(dayRule.workStart || settings?.workStart || DEFAULT_SETTINGS.workStart),
    workEnd: String(dayRule.workEnd || settings?.workEnd || DEFAULT_SETTINGS.workEnd),
    graceMins: Number(dayRule.graceMins ?? settings?.graceMins ?? DEFAULT_SETTINGS.graceMins) || 0,
    allowCheckIn: dayRule.allowCheckIn !== false,
    allowCheckOut: dayRule.allowCheckOut !== false,
  }
}

function normalizePayrollRules(settings) {
  const provided = settings?.payrollRules && typeof settings.payrollRules === 'object' ? settings.payrollRules : {}
  return {
    ...DEFAULT_SETTINGS.payrollRules,
    ...provided,
    expectedWorkDays: Number(provided.expectedWorkDays ?? DEFAULT_SETTINGS.payrollRules.expectedWorkDays) || DEFAULT_SETTINGS.payrollRules.expectedWorkDays,
    defaultAllowedHolidays: Number(provided.defaultAllowedHolidays ?? DEFAULT_SETTINGS.payrollRules.defaultAllowedHolidays) || 0,
    latePenaltyFraction: Number(provided.latePenaltyFraction ?? DEFAULT_SETTINGS.payrollRules.latePenaltyFraction) || 0,
    perfectAttendanceBonus: Number(provided.perfectAttendanceBonus ?? DEFAULT_SETTINGS.payrollRules.perfectAttendanceBonus) || 0,
    noLateBonus: Number(provided.noLateBonus ?? DEFAULT_SETTINGS.payrollRules.noLateBonus) || 0,
    overtimeEnabled: provided.overtimeEnabled !== false,
    overtimeThresholdMins: Number(provided.overtimeThresholdMins ?? DEFAULT_SETTINGS.payrollRules.overtimeThresholdMins) || 0,
    overtimeMultiplier: Number(provided.overtimeMultiplier ?? DEFAULT_SETTINGS.payrollRules.overtimeMultiplier) || DEFAULT_SETTINGS.payrollRules.overtimeMultiplier,
    seasonalOvertimeMultiplier: Number(provided.seasonalOvertimeMultiplier ?? DEFAULT_SETTINGS.payrollRules.seasonalOvertimeMultiplier) || DEFAULT_SETTINGS.payrollRules.seasonalOvertimeMultiplier,
    seasonalOvertimeStart: String(provided.seasonalOvertimeStart || DEFAULT_SETTINGS.payrollRules.seasonalOvertimeStart),
    seasonalOvertimeEnd: String(provided.seasonalOvertimeEnd || DEFAULT_SETTINGS.payrollRules.seasonalOvertimeEnd),
  }
}

export function monthKeyFromDateKey(dateKey) {
  return String(dateKey || '').slice(0, 7)
}

function getMonthRange(monthKey) {
  const month = String(monthKey || '').slice(0, 7)
  const start = `${month}-01`
  const endDate = new Date(`${month}-01T00:00:00.000Z`)
  endDate.setUTCMonth(endDate.getUTCMonth() + 1)
  endDate.setUTCDate(0) // last day of original month
  const end = endDate.toISOString().slice(0, 10)
  return { month, start, end }
}

function parseHm(value) {
  const [h, m] = String(value || '').split(':').map((part) => Number(part))
  return {
    hours: Number.isFinite(h) ? h : 0,
    minutes: Number.isFinite(m) ? m : 0,
  }
}

function minutesBetween(startIso, endIso) {
  const start = new Date(startIso)
  const end = new Date(endIso)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000))
}

function isMonthDayInRange(monthDay, startMonthDay, endMonthDay) {
  const value = String(monthDay || '')
  const start = String(startMonthDay || '')
  const end = String(endMonthDay || '')
  if (!value || !start || !end) return false
  if (start <= end) {
    return value >= start && value <= end
  }
  return value >= start || value <= end
}

function buildScheduledEndIso(dateKey, workEnd) {
  const { hours, minutes } = parseHm(workEnd)
  const scheduled = new Date(`${dateKey}T00:00:00`)
  scheduled.setHours(hours, minutes, 0, 0)
  return scheduled.toISOString()
}

function calculateOvertimeMeta({ dateKey, checkInAt, checkOutAt, settings }) {
  const payroll = normalizePayrollRules(settings)
  if (!payroll.overtimeEnabled) {
    return {
      overtimeMinutes: 0,
      overtimeHours: 0,
      overtimeMultiplier: 0,
      overtimePay: 0,
      overtimeLabel: '',
      workedMinutes: minutesBetween(checkInAt, checkOutAt),
    }
  }
  if (!checkInAt || !checkOutAt) {
    return {
      overtimeMinutes: 0,
      overtimeHours: 0,
      overtimeMultiplier: 0,
      overtimePay: 0,
      overtimeLabel: '',
      workedMinutes: 0,
    }
  }

  const schedule = getScheduleForDate(dateKey, settings)
  if (!schedule.enabled) {
    return {
      overtimeMinutes: 0,
      overtimeHours: 0,
      overtimeMultiplier: 0,
      overtimePay: 0,
      overtimeLabel: '',
      workedMinutes: minutesBetween(checkInAt, checkOutAt),
    }
  }

  const scheduledEndIso = buildScheduledEndIso(dateKey, schedule.workEnd || APP_CONFIG.workEnd || '18:00')
  const overtimeFloorMinutes = Math.max(0, Number(payroll.overtimeThresholdMins) || 0)
  const rawOvertimeMinutes = minutesBetween(scheduledEndIso, checkOutAt)
  const overtimeMinutes = Math.max(0, rawOvertimeMinutes - overtimeFloorMinutes)
  const monthDay = String(dateKey || '').slice(5, 10)
  const seasonal = isMonthDayInRange(monthDay, payroll.seasonalOvertimeStart, payroll.seasonalOvertimeEnd)
  const overtimeMultiplier = overtimeMinutes > 0
    ? (seasonal ? Number(payroll.seasonalOvertimeMultiplier || 0) || 0 : Number(payroll.overtimeMultiplier || 0) || 0)
    : 0
  const overtimeHours = Math.round((overtimeMinutes / 60) * 100) / 100
  return {
    overtimeMinutes,
    overtimeHours,
    overtimeMultiplier,
    overtimePay: 0,
    overtimeLabel: overtimeMinutes > 0 ? (seasonal ? 'Seasonal OT' : 'Overtime') : '',
    workedMinutes: minutesBetween(checkInAt, checkOutAt),
  }
}

function sumCurrency(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

export function computeSalary({ dailyRate, allowedHolidays, expectedWorkDays, daysPresent, lateDays, manualAgg = {}, overtimeAgg = {}, rules, payType, roleRate }) {
  const rate = sumCurrency(dailyRate)
  const expected = Math.max(0, Number(expectedWorkDays) || 0)
  const present = Math.max(0, Number(daysPresent) || 0)
  const late = Math.max(0, Number(lateDays) || 0)
  const allow = Math.max(0, Number(allowedHolidays) || 0)
  const payroll = normalizePayrollRules({ payrollRules: rules })

  const daysAbsent = payType === 'MONTHLY' ? 0 : Math.max(0, expected - present)

  let attendanceBase = 0
  let attendanceUnpaidDed = 0
  let lateDeduction = 0

  if (payType === 'MONTHLY') {
    // For monthly paid, base salary is fixed role rate
    attendanceBase = sumCurrency(roleRate)
    // No deductions for absence or late for monthly (or handle differently if needed)
    attendanceUnpaidDed = 0
    lateDeduction = 0
  } else {
    // Daily pay logic
    const paidLeave = Math.min(daysAbsent, allow)
    const unpaidLeave = Math.max(0, daysAbsent - allow)

    attendanceBase = sumCurrency(rate * (present + paidLeave))
    attendanceUnpaidDed = sumCurrency(rate * unpaidLeave)
    lateDeduction = sumCurrency(rate * payroll.latePenaltyFraction * late)
  }

  const manualSalary = sumCurrency(manualAgg.totalDailySalary || 0)
  const manualDeductions = sumCurrency(manualAgg.totalDeductions || 0)
  const overtimePay = sumCurrency(overtimeAgg.totalOvertimePay || 0)
  const overtimeMinutes = Math.max(0, Number(overtimeAgg.totalOvertimeMinutes) || 0)
  const overtimeHours = Math.round((overtimeMinutes / 60) * 100) / 100

  const baseSalary = sumCurrency(attendanceBase + manualSalary + overtimePay)
  const deductions = sumCurrency(attendanceUnpaidDed + lateDeduction + manualDeductions)

  const bonus =
    sumCurrency((daysAbsent === 0 ? payroll.perfectAttendanceBonus : 0) + (late === 0 ? payroll.noLateBonus : 0))

  const finalSalary = sumCurrency(baseSalary - deductions + bonus)

  return {
    dailyRate: rate,
    expectedWorkDays: expected,
    allowedHolidays: allow,
    daysPresent: present,
    daysAbsent: payType === 'MONTHLY' ? 0 : Math.max(0, expected - present),
    paidLeave: payType === 'MONTHLY' ? 0 : Math.min(Math.max(0, expected - present), allow),
    unpaidLeave: payType === 'MONTHLY' ? 0 : Math.max(0, Math.max(0, expected - present) - allow),
    lateDays: late,
    attendanceBase,
    manualSalary,
    manualDeductions,
    overtimePay,
    overtimeMinutes,
    overtimeHours,
    attendanceUnpaidDed,
    lateDeduction,
    baseSalary,
    deductions,
    bonus,
    finalSalary,
    manualCount: manualAgg.count || 0,
  }
}

function haversineDistance(gps1, gps2) {
  if (
    !gps1
    || !gps2
    || !Number.isFinite(Number(gps1.lat))
    || !Number.isFinite(Number(gps1.lng))
    || !Number.isFinite(Number(gps2.lat))
    || !Number.isFinite(Number(gps2.lng))
  ) return Infinity
  const toRad = (x) => x * Math.PI / 180
  const R = 6371e3 // meters
  const lat1 = toRad(Number(gps1.lat))
  const lat2 = toRad(Number(gps2.lat))
  const deltaLat = toRad(Number(gps2.lat) - Number(gps1.lat))
  const deltaLng = toRad(Number(gps2.lng) - Number(gps1.lng))
  const a = Math.sin(deltaLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng/2)**2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c
}

function normalizeGpsPayload(gps) {
  if (!gps) return null

  if (typeof gps === 'string') {
    const [latRaw, lngRaw] = gps.split(',').map((part) => Number(String(part || '').trim()))
    if (!Number.isFinite(latRaw) || !Number.isFinite(lngRaw)) return null
    return { lat: latRaw, lng: lngRaw, accuracy: null, capturedAt: null }
  }

  const lat = Number(gps.lat)
  const lng = Number(gps.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

  return {
    lat,
    lng,
    accuracy: Number.isFinite(Number(gps.accuracy)) ? Number(gps.accuracy) : null,
    capturedAt: gps.capturedAt ? String(gps.capturedAt) : null,
  }
}

function isLateWithSettings(isoDateTime, settings) {
  const date = new Date(isoDateTime)
  const dateKey = formatDateKeyForTimezone(date)
  const schedule = getScheduleForDate(dateKey, settings)
  if (!schedule.enabled) return false
  if (!schedule.allowCheckIn) return false

  const [hours, minutes] = String(schedule.workStart || APP_CONFIG.workStart)
    .split(':')
    .map((value) => Number(value))
  const grace = Number(schedule.graceMins ?? APP_CONFIG.gracePeriodMinutes) || 0

  const cutoff = new Date(date)
  cutoff.setHours(hours || 0, (minutes || 0) + grace, 0, 0)
  return date.getTime() > cutoff.getTime()
}

const baseUsers = [
  { id: 'u001', email: 'admin@wybefashion.com', name: 'Store Admin', role: 'admin' },
  { id: 'u002', email: 'nadeesha@wybefashion.com', name: 'Nadeesha', role: 'employee' },
  { id: 'u003', email: 'ishara@wybefashion.com', name: 'Ishara', role: 'employee' },
]


function readJson(key, fallback) {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return fallback
  }

  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

function bootstrapDemo() {
  if (!localStorage.getItem(DEMO_USERS_KEY)) {
    writeJson(DEMO_USERS_KEY, baseUsers)
  }

  if (!localStorage.getItem(DEMO_LOGS_KEY)) {
    writeJson(DEMO_LOGS_KEY, [])
  }

  if (!localStorage.getItem(DEMO_TOKENS_KEY)) {
    writeJson(DEMO_TOKENS_KEY, [])
  }

  if (!localStorage.getItem(DEMO_SETTINGS_KEY)) {
    writeJson(DEMO_SETTINGS_KEY, DEFAULT_SETTINGS)
  }
}

function safeName(email, displayName) {
  if (displayName) {
    return displayName
  }

  if (!email) {
    return 'Employee'
  }

  return email.split('@')[0]
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function setAuthError(message) {
  sessionStorage.setItem(AUTH_ERROR_KEY, message)
}

export function consumeAuthError() {
  const message = sessionStorage.getItem(AUTH_ERROR_KEY)
  if (!message) {
    return ''
  }
  sessionStorage.removeItem(AUTH_ERROR_KEY)
  return message
}

async function enrichFirebaseUser(firebaseUser) {
  if (!firebaseUser) {
    return null
  }

  const tokenResult = await firebaseUser.getIdTokenResult().catch(() => null)
  const roleFromClaim = tokenResult?.claims?.role
  const normalizedEmail = normalizeEmail(firebaseUser.email)

  const profileRef = doc(db, 'employees', firebaseUser.uid)
  let profile = null
  let invited = null
  let profileReadError = null
  let inviteReadError = null

  try {
    const profileSnap = await getDoc(profileRef)
    if (profileSnap?.exists()) {
      profile = profileSnap.data()
    }
  } catch (error) {
    profileReadError = error
  }

  if (normalizedEmail) {
    const inviteQuery = query(
      collection(db, 'employees'),
      where('email', '==', normalizedEmail),
      limit(10),
    )
    try {
      const inviteSnap = await getDocs(inviteQuery)
      const inviteCandidates = (inviteSnap?.docs || []).map((docItem) => ({ id: docItem.id, ...docItem.data() }))
      invited = inviteCandidates.find((row) => row.active !== false && row.role === 'admin')
        || inviteCandidates.find((row) => row.active !== false)
        || inviteCandidates[0]
        || null
    } catch (error) {
      inviteReadError = error
    }
  }

  // Employees are often pre-created by admin under a generated document id, not their Firebase UID.
  // Use that invited record directly instead of requiring a UID-based write during first login.
  if (!profile && invited) {
    profile = invited
  }

  if (profile && invited && normalizedEmail) {
    const needsRoleSync = invited.role === 'admin' && profile.role !== 'admin'
    const needsActiveSync = invited.active === false && profile.active !== false
    const needsNameSync = !profile.name && invited.name
    const needsEmailSync = normalizeEmail(profile.email) !== normalizedEmail
    const needsPayrollRoleSync = !profile.roleName && invited.roleName
    const needsRateSync = profile.dailyRate === undefined && invited.dailyRate !== undefined
    const needsHolidaySync = profile.allowedHolidays === undefined && invited.allowedHolidays !== undefined
    const profileDocMatchesUid = profileRef.id === (profile.id || '')
    if (profileDocMatchesUid && (needsRoleSync || needsActiveSync || needsNameSync || needsEmailSync || needsPayrollRoleSync || needsRateSync || needsHolidaySync)) {
      await setDoc(
        profileRef,
        {
          name: profile.name || invited.name || safeName(firebaseUser.email, firebaseUser.displayName),
          email: normalizedEmail,
          role: needsRoleSync ? 'admin' : (profile.role || invited.role || 'employee'),
          active: needsActiveSync ? false : profile.active !== false,
          roleName: profile.roleName || invited.roleName || '',
          dailyRate: Number(profile.dailyRate ?? invited.dailyRate ?? 0) || 0,
          allowedHolidays: Number(profile.allowedHolidays ?? invited.allowedHolidays ?? 0) || 0,
          updatedAt: serverTimestamp(),
          createdAt: profile.createdAt || invited.createdAt || serverTimestamp(),
        },
        { merge: true },
      ).catch(() => null)

      const claimed = await getDoc(profileRef).catch(() => null)
      if (claimed?.exists()) {
        profile = claimed.data()
      }
    }
  }

  if (!profile && !invited && (profileReadError?.code === 'permission-denied' || inviteReadError?.code === 'permission-denied')) {
    setAuthError('Access denied because employee profile lookup is blocked by Firestore rules. Deploy the latest firestore rules, then try signing in again.')
    await firebaseSignOut(auth)
    return null
  }

  if (!profile) {
    setAuthError(`Access denied. Signed in as ${normalizedEmail || 'unknown email'}, but no active employee record matched that email.`)
    await firebaseSignOut(auth)
    return null
  }

  if (profile.active === false) {
    setAuthError('Access denied. Your account is inactive. Please contact admin.')
    await firebaseSignOut(auth)
    return null
  }

  return {
    uid: firebaseUser.uid,
    email: normalizedEmail || firebaseUser.email,
    displayName: firebaseUser.displayName,
    name: profile?.name || safeName(firebaseUser.email, firebaseUser.displayName),
    role: roleFromClaim || profile?.role || 'employee',
  }
}

bootstrapDemo()

export function isProductionMode() {
  return isFirebaseConfigured
}

export function getTokenFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('t')?.toUpperCase() || ''
}

export function getTvDisplaySessionFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return params.get('ds')?.trim() || ''
}

export function getStoredTvDisplaySessionToken() {
  return localStorage.getItem(TV_DISPLAY_SESSION_KEY) || ''
}

export function saveTvDisplaySessionToken(token) {
  if (!token) {
    localStorage.removeItem(TV_DISPLAY_SESSION_KEY)
    return
  }
  localStorage.setItem(TV_DISPLAY_SESSION_KEY, String(token).trim())
}

export function clearTvDisplaySessionToken() {
  localStorage.removeItem(TV_DISPLAY_SESSION_KEY)
}

export function getCurrentDemoUser() {
  return readJson(DEMO_SESSION_KEY, null)
}

export function subscribeAuth(callback) {
  if (isFirebaseConfigured) {
    let stopProfileWatch = null

    const stopAuthWatch = onAuthStateChanged(auth, async (firebaseUser) => {
      if (stopProfileWatch) {
        stopProfileWatch()
        stopProfileWatch = null
      }

      if (!firebaseUser) {
        callback(null)
        return
      }

      const enriched = await enrichFirebaseUser(firebaseUser)
      callback(enriched)

      const profileRef = doc(db, 'employees', firebaseUser.uid)
      stopProfileWatch = onSnapshot(
        profileRef,
        (profileSnap) => {
          const profile = profileSnap.exists() ? profileSnap.data() : null
          callback({
            uid: firebaseUser.uid,
            email: normalizeEmail(firebaseUser.email) || firebaseUser.email,
            displayName: firebaseUser.displayName,
            name: profile?.name || enriched?.name || safeName(firebaseUser.email, firebaseUser.displayName),
            role: profile?.role || enriched?.role || 'employee',
          })
        },
        () => {
          callback(enriched)
        },
      )
    })

    return () => {
      if (stopProfileWatch) {
        stopProfileWatch()
      }
      stopAuthWatch()
    }
  }

  callback(getCurrentDemoUser())
  return () => {}
}

export async function signInWithGoogle() {
  if (!isFirebaseConfigured) {
    throw new Error('Google sign-in needs Firebase config.')
  }

  const result = await signInWithPopup(auth, googleProvider)
  return enrichFirebaseUser(result.user)
}

export async function demoSignIn(email) {
  const users = readJson(DEMO_USERS_KEY, [])
  const normalized = email.trim().toLowerCase()
  const existing = users.find((u) => u.email === normalized)

  if (!existing) {
    throw new Error('Access denied. Your account is not registered by admin yet.')
  }

  writeJson(DEMO_SESSION_KEY, existing)
  return existing
}

export async function signOut() {
  if (isFirebaseConfigured) {
    await firebaseSignOut(auth)
    return
  }

  localStorage.removeItem(DEMO_SESSION_KEY)
}

function getActionState(record) {
  if (!record || !record.checkInAt) {
    return 'checkIn'
  }

  if (!record.checkOutAt) {
    return 'checkOut'
  }

  return 'complete'
}

async function getTvDisplaySessionRecord(sessionToken) {
  const token = String(sessionToken || '').trim()
  if (!token) return null

  if (isFirebaseConfigured) {
    const snapshot = await getDoc(doc(db, 'tv_sessions', token)).catch(() => null)
    if (!snapshot?.exists()) return null
    return { id: snapshot.id, ...snapshot.data() }
  }

  const sessions = readJson(DEMO_TV_SESSIONS_KEY, [])
  return sessions.find((item) => item.id === token && item.active !== false) || null
}

async function getActiveTvDisplaySessionRecord() {
  if (isFirebaseConfigured) {
    const snapshot = await getDocs(query(collection(db, 'tv_sessions'), where('active', '==', true), limit(1))).catch(() => null)
    const first = snapshot?.docs?.[0]
    if (!first) return null
    return { id: first.id, ...first.data() }
  }

  const sessions = readJson(DEMO_TV_SESSIONS_KEY, [])
  return sessions.find((item) => item.active !== false) || null
}

function buildTvDisplaySessionResult(sessionId, issuedBy, refreshSeconds) {
  const ttl = 10 * 365 * 24 * 60 * 60
  const issuedAtMs = Date.now()
  const expiresAtMs = issuedAtMs + ttl * 1000
  return {
    id: sessionId,
    sessionToken: sessionId,
    issuedBy: issuedBy || null,
    refreshInterval: normalizeRefreshIntervalSeconds(refreshSeconds || APP_CONFIG.tokenRefreshSeconds),
    active: true,
    issuedAtMs,
    expiresAtMs,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    launchUrl: `${window.location.origin}/tv?ds=${encodeURIComponent(sessionId)}`,
  }
}

export async function getEmployeeToday(userId) {
  const date = getTodayKey()

  if (isFirebaseConfigured) {
    try {
      const recordRef = doc(db, 'attendance_daily', `${userId}_${date}`)
      const recordSnap = await getDoc(recordRef)
      const record = recordSnap.exists() ? recordSnap.data() : null

      return {
        record,
        nextAction: getActionState(record),
      }
    } catch (error) {
      if (error?.code === 'permission-denied') {
        return {
          record: null,
          nextAction: 'checkIn',
        }
      }

      throw error
    }
  }

  const logs = readJson(DEMO_LOGS_KEY, [])
  const record = logs.find((item) => item.userId === userId && item.date === date) || null

  return {
    record,
    nextAction: getActionState(record),
  }
}

export async function getEmployeeHistory(userId, days = 7) {
  if (isFirebaseConfigured) {
    const snapshot = await getDocs(
      query(
        collection(db, 'attendance_daily'),
        where('userId', '==', userId),
        orderBy('date', 'desc'),
        limit(days),
      ),
    )
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  const logs = readJson(DEMO_LOGS_KEY, [])
    .filter((item) => item.userId === userId)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, days)
  return logs
}

export async function submitAttendance({ user, token, action }) {
  if (!user) {
    throw new Error('Please sign in first.')
  }

  if (!token) {
    throw new Error('Missing QR token. Scan the TV QR code again.')
  }

  const runtimeSettings = await getAdminSettings()
  const todayKey = getTodayKey()
  const schedule = getScheduleForDate(todayKey, runtimeSettings)
  if (!schedule.enabled) {
    throw new Error('Attendance is disabled for today. Please contact admin.')
  }
  if (action === 'checkIn' && !schedule.allowCheckIn) {
    throw new Error('Check-in is disabled for today. Please contact admin.')
  }
  if (action === 'checkOut' && !schedule.allowCheckOut) {
    throw new Error('Check-out is disabled for today. Please contact admin.')
  }
  const shopGps = await getShopGps()
  const radius = runtimeSettings.verificationRadiusMeters || APP_CONFIG.verificationRadiusMeters
  const normalizedGps = normalizeGpsPayload(user?.gps)
  if (runtimeSettings.gpsVerify) {
    if (!normalizedGps) {
      throw new Error('GPS verification is required. Please enable location on your device.')
    }
    const gpsCapturedAtMs = normalizedGps.capturedAt ? new Date(normalizedGps.capturedAt).getTime() : NaN
    if (!Number.isFinite(gpsCapturedAtMs) || Date.now() - gpsCapturedAtMs > 2 * 60 * 1000) {
      throw new Error('Location is stale. Please allow location access and try again from the check-in screen.')
    }
    const distance = haversineDistance(normalizedGps, shopGps)
    if (distance > radius) {
      throw new Error(`GPS out of range. Distance: ${Math.round(distance)}m (max ${radius}m from shop at ${shopGps.lat.toFixed(4)},${shopGps.lng.toFixed(4)})`)
    }
  }

  const uid = user.uid || user.id
  const employeeProfile = await getEmployeeProfile(user).catch(() => null)
  const dailyRateSnapshot = Number(employeeProfile?.dailyRate || user.dailyRate || 0) || 0

  if (isFirebaseConfigured) {
    const date = todayKey
    const dailyRef = doc(db, 'attendance_daily', `${uid}_${date}`)
    const tokenRef = doc(db, 'qr_tokens', token)

    const { timestamp, lateFlag } = await runTransaction(db, async (transaction) => {
      const tokenSnap = await transaction.get(tokenRef)
      if (!tokenSnap.exists()) {
        throw new Error('Invalid QR token. Scan the TV screen again.')
      }

      const tokenData = tokenSnap.data()
      if (!tokenData.active || tokenData.expiresAtMs < Date.now()) {
        throw new Error('QR token expired. Scan the TV screen again.')
      }

      const dailySnap = await transaction.get(dailyRef)
      const record = dailySnap.exists() ? dailySnap.data() : null
      const timestamp = now().toISOString()
      const lateFlag = isLateWithSettings(timestamp, runtimeSettings)

      if (action === 'checkIn') {
        if (record?.checkInAt) {
          throw new Error('You already checked in today.')
        }

        transaction.set(
          dailyRef,
          {
            userId: uid,
            date,
            employeeName: user.name || safeName(user.email, user.displayName),
            dailyRate: dailyRateSnapshot,
            checkInAt: timestamp,
            checkOutAt: null,
            late: lateFlag,
            branchId: tokenData.branchId || APP_CONFIG.branchId,
            checkInToken: token,
            checkOutToken: null,
            checkInGps: normalizedGps,
            updatedAt: serverTimestamp(),
            createdAt: record?.createdAt || serverTimestamp(),
          },
          { merge: true },
        )
      }

      if (action === 'checkOut') {
        if (!record?.checkInAt) {
          throw new Error('You need to check in first.')
        }

        if (record?.checkOutAt) {
          throw new Error('You already checked out today.')
        }

        const overtimeMeta = calculateOvertimeMeta({
          dateKey: date,
          checkInAt: record.checkInAt,
          checkOutAt: timestamp,
          settings: runtimeSettings,
        })
        const overtimeRatePerHour = sumCurrency((dailyRateSnapshot / 8) * overtimeMeta.overtimeMultiplier)
        const overtimePay = sumCurrency(overtimeMeta.overtimeHours * overtimeRatePerHour)

        transaction.set(
          dailyRef,
          {
            checkOutAt: timestamp,
            checkOutToken: token,
            checkOutGps: normalizedGps,
            overtimeMinutes: overtimeMeta.overtimeMinutes,
            overtimeHours: overtimeMeta.overtimeHours,
            overtimeMultiplier: overtimeMeta.overtimeMultiplier,
            overtimePay,
            overtimeLabel: overtimeMeta.overtimeLabel,
            workedMinutes: overtimeMeta.workedMinutes,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        )
      }

      transaction.set(
        tokenRef,
        {
          active: false,
          lastUsedAt: serverTimestamp(),
          lastUsedBy: uid,
          scansCount: (tokenData.scansCount || 0) + 1,
        },
        { merge: true },
      )

      return { timestamp, lateFlag }
    })

    await addDoc(collection(db, 'attendance_logs'), {
      userId: uid,
      employeeName: user.name || safeName(user.email, user.displayName),
      action,
      late: action === 'checkIn' ? lateFlag : false,
      date,
      token,
      gps: normalizedGps,
      branchId: APP_CONFIG.branchId,
      createdAt: serverTimestamp(),
      clientTs: timestamp,
    })

    return {
      ok: true,
      action,
      timestamp,
      message: `${action === 'checkIn' ? 'Check-In' : 'Check-Out'} recorded at ${humanTime(new Date(timestamp))}`,
    }
  }

  const active = readJson(DEMO_TV_KEY, null)
  if (!active || active.token !== token || new Date(active.expiresAt).getTime() < Date.now()) {
    throw new Error('QR token expired. Scan the TV screen again.')
  }

  const date = todayKey
  const timestamp = now().toISOString()
  const logs = readJson(DEMO_LOGS_KEY, [])
  const idx = logs.findIndex((item) => item.userId === user.id && item.date === date)

  let record = idx >= 0 ? logs[idx] : null

  if (action === 'checkIn') {
    if (record?.checkInAt) {
      throw new Error('You already checked in today.')
    }

    record = {
      userId: user.id,
      date,
      employeeName: user.name,
      dailyRate: dailyRateSnapshot,
      checkInAt: timestamp,
      checkOutAt: null,
      late: isLateWithSettings(timestamp, runtimeSettings),
      checkInToken: token,
      checkOutToken: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }

    if (idx >= 0) {
      logs[idx] = record
    } else {
      logs.push(record)
    }

    writeJson(DEMO_LOGS_KEY, logs)

    const actionLogs = readJson('scantrack_demo_action_logs', [])
    actionLogs.push({
      id: crypto.randomUUID(),
      userId: user.id,
      employeeName: user.name,
      action,
      late: record.late,
      date,
      token,
      gps: normalizedGps,
      clientTs: timestamp,
    })
    writeJson('scantrack_demo_action_logs', actionLogs)

    return {
      ok: true,
      action,
      timestamp,
      message: `Check-In recorded at ${humanTime(new Date(timestamp))}`,
    }
  }

  if (!record?.checkInAt) {
    throw new Error('You need to check in first.')
  }

  if (record.checkOutAt) {
    throw new Error('You already checked out today.')
  }

  const overtimeMeta = calculateOvertimeMeta({
    dateKey: date,
    checkInAt: record.checkInAt,
    checkOutAt: timestamp,
    settings: runtimeSettings,
  })
  const overtimeRatePerHour = sumCurrency((dailyRateSnapshot / 8) * overtimeMeta.overtimeMultiplier)
  const overtimePay = sumCurrency(overtimeMeta.overtimeHours * overtimeRatePerHour)

  record.checkOutAt = timestamp
  record.checkOutToken = token
  record.overtimeMinutes = overtimeMeta.overtimeMinutes
  record.overtimeHours = overtimeMeta.overtimeHours
  record.overtimeMultiplier = overtimeMeta.overtimeMultiplier
  record.overtimePay = overtimePay
  record.overtimeLabel = overtimeMeta.overtimeLabel
  record.workedMinutes = overtimeMeta.workedMinutes
  record.updatedAt = timestamp
  logs[idx] = record
  writeJson(DEMO_LOGS_KEY, logs)

  const actionLogs = readJson('scantrack_demo_action_logs', [])
  actionLogs.push({
    id: crypto.randomUUID(),
    userId: user.id,
    employeeName: user.name,
    action,
    late: false,
    date,
    token,
    gps: normalizedGps,
    clientTs: timestamp,
  })
  writeJson('scantrack_demo_action_logs', actionLogs)

  return {
    ok: true,
    action,
    timestamp,
    message: `Check-Out recorded at ${humanTime(new Date(timestamp))}`,
  }
}

export async function getAdminAttendance(date = getTodayKey()) {
  if (isFirebaseConfigured) {
    try {
      const recordsQuery = query(
        collection(db, 'attendance_daily'),
        where('date', '==', date),
        orderBy('employeeName', 'asc'),
      )
      const snapshot = await getDocs(recordsQuery)
      return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
    } catch (error) {
      if (error?.code === 'permission-denied') {
        throw new Error('Admin access is not configured yet. Set your user role as admin in employees collection and deploy firestore rules.')
      }

      throw error
    }
  }

  const logs = readJson(DEMO_LOGS_KEY, [])
  return logs.filter((item) => item.date === date)
}

export async function getAdminLogs() {
  if (isFirebaseConfigured) {
    const logsQuery = query(collection(db, 'attendance_logs'), orderBy('clientTs', 'desc'), limit(300))
    const snapshot = await getDocs(logsQuery)
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  return readJson('scantrack_demo_action_logs', []).sort((a, b) => b.clientTs.localeCompare(a.clientTs))
}

export async function getAttendanceByDateRange(startDate, endDate) {
  if (isFirebaseConfigured) {
    const logsQuery = query(
      collection(db, 'attendance_logs'),
      where('date', '>=', startDate),
      where('date', '<=', endDate),
      orderBy('date', 'desc'),
    )
    const snapshot = await getDocs(logsQuery)
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  const logs = readJson('scantrack_demo_action_logs', [])
  return logs.filter((log) => log.date >= startDate && log.date <= endDate).sort((a, b) => b.date.localeCompare(a.date))
}

export async function getShopGps() {
  const settings = await getAdminSettings()
  return settings.shopGps || APP_CONFIG.shopGps
}

export async function setShopGps(gps, radius) {
  if (isFirebaseConfigured) {
    const settingsRef = doc(db, 'settings', 'attendance')
    await setDoc(settingsRef, { 
      shopGps: gps,
      verificationRadiusMeters: radius,
      updatedAt: serverTimestamp() 
    }, { merge: true })
    return
  }
  const current = readJson(DEMO_SETTINGS_KEY, {})
  writeJson(DEMO_SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...current, shopGps: gps, verificationRadiusMeters: radius })
}

export async function getAdminSettings() {
  if (isFirebaseConfigured) {
    const settingsRef = doc(db, 'settings', 'attendance')
    const snapshot = await getDoc(settingsRef)
    if (!snapshot.exists()) {
      return DEFAULT_SETTINGS
    }
    const data = snapshot.data() || {}
    return {
      ...DEFAULT_SETTINGS,
      ...data,
      refreshInterval: normalizeRefreshIntervalSeconds(data.refreshInterval ?? DEFAULT_SETTINGS.refreshInterval),
      weeklySchedule: normalizeWeeklySchedule(data),
      payrollRules: normalizePayrollRules(data),
    }
  }

  const data = readJson(DEMO_SETTINGS_KEY, DEFAULT_SETTINGS) || {}
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    refreshInterval: normalizeRefreshIntervalSeconds(data.refreshInterval ?? DEFAULT_SETTINGS.refreshInterval),
    weeklySchedule: normalizeWeeklySchedule(data),
    payrollRules: normalizePayrollRules(data),
  }
}

export async function saveAdminSettings(payload) {
  if (isFirebaseConfigured) {
    const settingsRef = doc(db, 'settings', 'attendance')
    const normalized = {
      ...payload,
      refreshInterval: normalizeRefreshIntervalSeconds(payload.refreshInterval ?? DEFAULT_SETTINGS.refreshInterval),
      weeklySchedule: normalizeWeeklySchedule(payload),
      payrollRules: normalizePayrollRules(payload),
      updatedAt: serverTimestamp(),
    }
    await setDoc(settingsRef, normalized, { merge: true })
    return
  }

  writeJson(DEMO_SETTINGS_KEY, {
    ...DEFAULT_SETTINGS,
    ...payload,
    refreshInterval: normalizeRefreshIntervalSeconds(payload.refreshInterval ?? DEFAULT_SETTINGS.refreshInterval),
    weeklySchedule: normalizeWeeklySchedule(payload),
    payrollRules: normalizePayrollRules(payload),
  })
}

export async function getTokenHistory() {
  if (isFirebaseConfigured) {
    const historyQuery = query(collection(db, 'qr_tokens'), orderBy('issuedAtMs', 'desc'), limit(20))
    const snapshot = await getDocs(historyQuery)
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  return readJson(DEMO_TOKENS_KEY, [])
}

export async function clearNotifications() {
  if (isFirebaseConfigured) {
    const logsQuery = query(collection(db, 'attendance_logs'), where('late', '==', true))
    const snapshot = await getDocs(logsQuery)
    await Promise.all(snapshot.docs.map((docItem) => deleteDoc(docItem.ref)))
    return
  }

  const logs = readJson('scantrack_demo_action_logs', [])
  writeJson('scantrack_demo_action_logs', logs.filter((item) => !item.late))
}

export async function clearNotificationsForDate(date = getTodayKey()) {
  if (isFirebaseConfigured) {
    const logsQuery = query(
      collection(db, 'attendance_logs'),
      where('date', '==', date),
      where('late', '==', true),
    )
    const snapshot = await getDocs(logsQuery)
    await Promise.all(snapshot.docs.map((docItem) => deleteDoc(docItem.ref)))
    return
  }

  const logs = readJson('scantrack_demo_action_logs', [])
  writeJson('scantrack_demo_action_logs', logs.filter((item) => !(item.date === date && item.late)))
}

export async function getAttendanceDailyForRange(startDate, endDate) {
  const start = String(startDate || '')
  const end = String(endDate || '')
  if (!start || !end) return []

  if (isFirebaseConfigured) {
    const q = query(
      collection(db, 'attendance_daily'),
      where('date', '>=', start),
      where('date', '<=', end),
      orderBy('date', 'asc'),
      limit(5000),
    )
    const snapshot = await getDocs(q)
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  const logs = readJson(DEMO_LOGS_KEY, [])
  return logs.filter((item) => item.date >= start && item.date <= end)
}

async function getAttendanceDailyForUserRange(userId, startDate, endDate) {
  const uid = String(userId || '')
  if (!uid) return []
  const start = String(startDate || '')
  const end = String(endDate || '')
  if (!start || !end) return []

  if (isFirebaseConfigured) {
    const q = query(
      collection(db, 'attendance_daily'),
      where('userId', '==', uid),
      where('date', '>=', start),
      where('date', '<=', end),
      orderBy('date', 'desc'),
      limit(1000),
    )
    const snapshot = await getDocs(q)
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  const logs = readJson(DEMO_LOGS_KEY, [])
  return logs.filter((item) => item.userId === uid && item.date >= start && item.date <= end).sort((a, b) => b.date.localeCompare(a.date))
}

function upsertDemoDailyPayment(record) {
  const payments = readJson(DEMO_DAILY_PAYMENTS_KEY, [])
  const key = `${record.userId}_${record.date}`
  const next = payments.filter((r) => `${r.userId}_${r.date}` !== key)
  next.unshift({ ...record, id: key })
  writeJson(DEMO_DAILY_PAYMENTS_KEY, next.slice(0, 1000))
}

function upsertDemoSalaryRecord(record) {
  const rows = readJson(DEMO_SALARY_KEY, [])
  const key = `${record.userId}_${record.month}`
  const next = rows.filter((r) => `${r.userId}_${r.month}` !== key)
  next.unshift({ ...record, id: key })
  writeJson(DEMO_SALARY_KEY, next.slice(0, 500))
}

function validateDailyPayment(payload) {
  if (!payload.userId || !payload.date || typeof payload.date !== 'string') throw new Error('userId and date required');
  if (Number.isNaN(Number(payload.dailySalary)) || Number(payload.dailySalary) < 0) throw new Error('dailySalary must be non-negative number');
  const totalDeductions = DEDUCTION_TYPES.reduce((sum, type) => sum + Number(payload.deductions?.[type] || 0), 0);
  if (totalDeductions < 0) throw new Error('deductions cannot be negative');
  if (payload.netPay !== undefined && Number.isNaN(Number(payload.netPay))) throw new Error('netPay must be number');
}

function computeDailyNet(dailySalary, deductions) {
  const salary = sumCurrency(dailySalary);
  const totalDed = sumCurrency(Object.values(deductions || {}).reduce((sum, v) => sum + Number(v), 0));
  return sumCurrency(salary - totalDed);
}

export async function createDailyPayment(payload, addedBy) {
  validateDailyPayment(payload);
  const netPay = computeDailyNet(payload.dailySalary, payload.deductions || {});
  const record = {
    userId: payload.userId,
    date: payload.date,
    employeeName: payload.employeeName || '',
    dailySalary: sumCurrency(payload.dailySalary),
    deductions: payload.deductions || {},
    totalDeductions: sumCurrency(Object.values(payload.deductions || {}).reduce((sum, v) => sum + Number(v), 0)),
    netPay,
    notes: payload.notes || '',
    addedBy: addedBy || null,
    addedAt: isFirebaseConfigured ? serverTimestamp() : now().toISOString(),
  };

  if (isFirebaseConfigured) {
    const docId = `${payload.userId}_${payload.date}`;
    await setDoc(doc(db, 'daily_payments', docId), record);
    return { id: docId, ...record };
  } else {
    upsertDemoDailyPayment(record);
    return { id: `${payload.userId}_${payload.date}`, ...record };
  }
}

export async function updateDailyPayment(docId, updates, addedBy) {
  if (isFirebaseConfigured) {
    const updatesWithTimestamps = {
      ...updates,
      updatedAt: serverTimestamp(),
      updatedBy: addedBy || null,
    };
    await setDoc(doc(db, 'daily_payments', docId), updatesWithTimestamps, { merge: true });
    return updatesWithTimestamps;
  } else {
    const payments = readJson(DEMO_DAILY_PAYMENTS_KEY, []);
    const idx = payments.findIndex(p => p.id === docId);
    if (idx === -1) throw new Error('Record not found');
    payments[idx] = { ...payments[idx], ...updates, updatedAt: now().toISOString() };
    writeDemoDailyPayments(payments);
    return payments[idx];
  }
}

export async function deleteDailyPayment(docId) {
  if (isFirebaseConfigured) {
    await deleteDoc(doc(db, 'daily_payments', docId));
    return true;
  } else {
    const payments = readJson(DEMO_DAILY_PAYMENTS_KEY, []);
    const next = payments.filter(p => p.id !== docId);
    writeDemoDailyPayments(next);
    return true;
  }
}

export async function getDailyPaymentsForMonth(monthKey) {
  const { start, end } = getMonthRange(monthKey);
  if (isFirebaseConfigured) {
    const q = query(
      collection(db, 'daily_payments'),
      where('date', '>=', start),
      where('date', '<=', end),
      orderBy('date', 'desc'),
      orderBy('employeeName')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
  } else {
    const payments = readJson(DEMO_DAILY_PAYMENTS_KEY, []);
    return payments.filter(p => p.date >= start && p.date <= end)
      .sort((a, b) => b.date.localeCompare(a.date) || String(a.employeeName).localeCompare(String(b.employeeName)));
  }
}

function writeDemoDailyPayments(payments) {
  writeJson(DEMO_DAILY_PAYMENTS_KEY, payments);
}

export function aggregateDailyPayments(payments) {
  const byUser = {};
  payments.forEach(p => {
    if (!byUser[p.userId]) {
      byUser[p.userId] = { totalDailySalary: 0, totalDeductions: 0, totalNetPay: 0, count: 0, employeeName: p.employeeName };
    }
    byUser[p.userId].totalDailySalary += Number(p.dailySalary || 0);
    byUser[p.userId].totalDeductions += Number(p.totalDeductions || 0);
    byUser[p.userId].totalNetPay += Number(p.netPay || 0);
    byUser[p.userId].count += 1;
  });
  return byUser;
}

export async function getSalaryRecordsForMonth(monthKey) {
  const { month } = getMonthRange(monthKey)
  if (isFirebaseConfigured) {
    const q = query(collection(db, 'salary_records'), where('month', '==', month), limit(500))
    const snapshot = await getDocs(q)
    return snapshot.docs
      .map((docItem) => ({ id: docItem.id, ...docItem.data() }))
      .sort((a, b) => String(a.employeeName || '').localeCompare(String(b.employeeName || '')))
  }

  return readJson(DEMO_SALARY_KEY, []).filter((r) => r.month === month)
}

export async function getEmployeeSalaryRecords(userId, limitMonths = 6) {
  const uid = String(userId || '')
  if (!uid) return []
  if (isFirebaseConfigured) {
    const q = query(collection(db, 'salary_records'), where('userId', '==', uid), limit(24))
    const snapshot = await getDocs(q)
    return snapshot.docs
      .map((docItem) => ({ id: docItem.id, ...docItem.data() }))
      .sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')))
      .slice(0, Math.max(1, Number(limitMonths) || 6))
  }

  return readJson(DEMO_SALARY_KEY, [])
    .filter((r) => r.userId === uid)
    .sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')))
    .slice(0, Math.max(1, Number(limitMonths) || 6))
}

export async function getEmployeeAttendanceForMonth(userId, monthKey) {
  const uid = String(userId || '')
  if (!uid || !monthKey) return []
  const { start, end } = getMonthRange(monthKey)

  if (isFirebaseConfigured) {
    const q = query(
      collection(db, 'attendance_daily'),
      where('userId', '==', uid),
      where('date', '>=', start),
      where('date', '<=', end),
      orderBy('date', 'asc'),
      limit(1000),
    )
    const snapshot = await getDocs(q)
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  return readJson(DEMO_LOGS_KEY, [])
    .filter((item) => item.userId === uid && item.date >= start && item.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export async function getEmployeeDailyPayments(userId, monthKey) {
  const uid = String(userId || '')
  if (!uid) return []

  const payments = await getDailyPaymentsForMonth(monthKey)
  return payments
    .filter((payment) => payment.userId === uid)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
}

export async function generateSalaryForMonth({ monthKey, generatedBy }) {
  const rules = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
  const payroll = normalizePayrollRules(rules)
  const { month, start, end } = getMonthRange(monthKey)
  const employees = await getEmployees()
  const activeStaff = employees.filter((e) => (e.role || 'employee') !== 'admin' && e.active !== false)
  const [attendance, dailyPayments] = await Promise.all([
    getAttendanceDailyForRange(start, end),
    getDailyPaymentsForMonth(monthKey)
  ])

  const attendanceByUser = new Map()
  for (const row of attendance) {
    const uid = row.userId
    if (!uid) continue
    if (!attendanceByUser.has(uid)) attendanceByUser.set(uid, [])
    attendanceByUser.get(uid).push(row)
  }

  const records = []
  for (const emp of activeStaff) {
    const uid = emp.id || emp.userId
    const attendanceRows = attendanceByUser.get(uid) || []
    const daysPresent = attendanceRows.filter((r) => r.checkInAt).length
    const lateDays = attendanceRows.filter((r) => r.late).length
    const allowedHolidays = Number(emp.allowedHolidays ?? payroll.defaultAllowedHolidays) || 0
    const overtimeAgg = {
      totalOvertimeMinutes: attendanceRows.reduce((sum, row) => sum + Number(row.overtimeMinutes || 0), 0),
      totalOvertimeHours: attendanceRows.reduce((sum, row) => sum + Number(row.overtimeHours || 0), 0),
      totalOvertimePay: attendanceRows.reduce((sum, row) => sum + Number(row.overtimePay || 0), 0),
    }

    // Get role info
    const roleName = emp.roleName || 'employee'
    const role = await getRoleByName(roleName).catch(() => null)
    const payType = role?.payType || 'DAILY'
    const roleRate = Number(role?.rate || 0)

    // For daily paid, sum the rateUsed from attendance
    // For monthly paid, use the fixed role rate
    const dailyRate = payType === 'MONTHLY' ? roleRate : attendanceRows.reduce((sum, row) => sum + Number(row.rateUsed || 0), 0) / Math.max(daysPresent, 1)

    const empDailyPayments = dailyPayments.filter(p => p.userId === uid)
    const manualAgg = aggregateDailyPayments(empDailyPayments)[uid] || { totalDailySalary: 0, totalDeductions: 0, count: 0 }

    const computed = computeSalary({
      dailyRate,
      allowedHolidays,
      expectedWorkDays: payroll.expectedWorkDays,
      daysPresent,
      lateDays,
      manualAgg,
      overtimeAgg,
      rules: payroll,
      payType,
      roleRate,
    })

    const record = {
      userId: uid,
      employeeName: emp.name || emp.email || uid,
      email: emp.email || '',
      roleName,
      payType,
      month,
      ...computed,
      overtimeMinutes: overtimeAgg.totalOvertimeMinutes,
      overtimeHours: overtimeAgg.totalOvertimeHours,
      overtimePay: overtimeAgg.totalOvertimePay,
      manualCount: manualAgg.count || 0,
      generatedBy: generatedBy || null,
      generatedAtMs: Date.now(),
    }

    records.push(record)

    if (isFirebaseConfigured) {
      await setDoc(
        doc(db, 'salary_records', `${uid}_${month}`),
        { ...record, generatedAt: serverTimestamp(), updatedAt: serverTimestamp() },
        { merge: true },
      )
    } else {
      upsertDemoSalaryRecord(record)
    }
  }

  return records.sort((a, b) => String(a.employeeName || '').localeCompare(String(b.employeeName || '')))
}

export async function getEmployeeSalaryEstimate(userId, monthKey = monthKeyFromDateKey(getTodayKey())) {
  const uid = String(userId || '')
  if (!uid) return null
  const rules = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
  const payroll = normalizePayrollRules(rules)
  const { month, start, end } = getMonthRange(monthKey)
  const todayKey = getTodayKey()
  const cappedEnd = todayKey.startsWith(month) && todayKey < end ? todayKey : end
  const rows = await getAttendanceDailyForUserRange(uid, start, cappedEnd)
  const daysPresent = rows.filter((r) => r.checkInAt).length
  const lateDays = rows.filter((r) => r.late).length
  const overtimeAgg = {
    totalOvertimeMinutes: rows.reduce((sum, row) => sum + Number(row.overtimeMinutes || 0), 0),
    totalOvertimeHours: rows.reduce((sum, row) => sum + Number(row.overtimeHours || 0), 0),
    totalOvertimePay: rows.reduce((sum, row) => sum + Number(row.overtimePay || 0), 0),
  }

  const emp = await getEmployeeProfile(uid).catch(() => null)
  const dailyRate = Number(emp?.dailyRate || 0) || 0
  const allowedHolidays = Number(emp?.allowedHolidays ?? payroll.defaultAllowedHolidays) || 0

  const earnedSoFar = sumCurrency(dailyRate * daysPresent)
  const bestCase = computeSalary({
    dailyRate,
    allowedHolidays,
    expectedWorkDays: payroll.expectedWorkDays,
    daysPresent: payroll.expectedWorkDays,
    lateDays,
    overtimeAgg,
    rules: payroll,
  })

  return {
    userId: uid,
    month,
    dailyRate,
    allowedHolidays,
    expectedWorkDays: payroll.expectedWorkDays,
    daysPresent,
    lateDays,
    overtimeMinutes: overtimeAgg.totalOvertimeMinutes,
    overtimeHours: overtimeAgg.totalOvertimeHours,
    overtimePay: overtimeAgg.totalOvertimePay,
    earnedSoFar,
    bestCaseFinalSalary: bestCase.finalSalary,
    asOfDate: cappedEnd,
  }
}

export async function clearAttendanceForDate(date) {
  if (isFirebaseConfigured) {
    const dailySnap = await getDocs(query(collection(db, 'attendance_daily'), where('date', '==', date)))
    const logsSnap = await getDocs(query(collection(db, 'attendance_logs'), where('date', '==', date)))

    await Promise.all([
      ...dailySnap.docs.map((docItem) => deleteDoc(docItem.ref)),
      ...logsSnap.docs.map((docItem) => deleteDoc(docItem.ref)),
    ])
    return
  }

  writeJson(
    DEMO_LOGS_KEY,
    readJson(DEMO_LOGS_KEY, []).filter((item) => item.date !== date),
  )
  writeJson(
    'scantrack_demo_action_logs',
    readJson('scantrack_demo_action_logs', []).filter((item) => item.date !== date),
  )
}

export async function getLateAlerts(date = getTodayKey()) {
  if (isFirebaseConfigured) {
    const snapshot = await getDocs(
      query(collection(db, 'attendance_logs'), where('date', '==', date), where('late', '==', true)),
    )
    return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
  }

  return readJson('scantrack_demo_action_logs', []).filter((item) => item.date === date && item.late)
}

export async function getEmployeeDirectory(date = getTodayKey()) {
  const [workers, records] = await Promise.all([getEmployees(), getAdminAttendance(date)])

  return workers
    .filter((worker) => worker.role !== 'admin')
    .map((worker) => {
      const uid = worker.id || worker.userId
      const daily = records.find((item) => item.userId === uid)

      let status = 'Not checked in'
      if (daily?.checkOutAt) {
        status = 'Checked out'
      } else if (daily?.checkInAt && daily?.late) {
        status = 'Checked in (late)'
      } else if (daily?.checkInAt) {
        status = 'Checked in (on time)'
      }

      return {
        ...worker,
        uid,
        status,
        late: daily?.late || false,
        checkInAt: daily?.checkInAt || null,
        checkOutAt: daily?.checkOutAt || null,
        workedMinutes: daily?.workedMinutes || null,
        overtimeMinutes: daily?.overtimeMinutes || 0,
        overtimeHours: daily?.overtimeHours || 0,
        overtimePay: daily?.overtimePay || 0,
        overtimeLabel: daily?.overtimeLabel || '',
      }
    })
}

export function summarizeAttendance(records) {
  const checkIns = records.filter((record) => record.checkInAt)
  const checkOuts = records.filter((record) => record.checkOutAt)
  const late = records.filter((record) => record.late)

  return {
    totalEmployees: records.length,
    checkedIn: checkIns.length,
    checkedOut: checkOuts.length,
    late: late.length,
    onTime: checkIns.length - late.length,
  }
}

export async function getEmployees() {
  if (isFirebaseConfigured) {
    try {
      const snapshot = await getDocs(query(collection(db, 'employees'), orderBy('name', 'asc')))
      return snapshot.docs
        .map((docItem) => ({ id: docItem.id, ...docItem.data() }))
        .filter((employee) => employee.active !== false)
    } catch (error) {
      if (error?.code === 'permission-denied') {
        throw new Error('Cannot read employees. Ensure your user has admin role in employees collection.')
      }

      throw error
    }
  }

  return readJson(DEMO_USERS_KEY, []).filter((employee) => employee.active !== false)
}

export async function getEmployeeProfile(userOrId) {
  if (!userOrId) return null
  const lookupId = typeof userOrId === 'object' ? String(userOrId.uid || userOrId.id || userOrId.userId || '').trim() : String(userOrId).trim()
  const lookupEmail = typeof userOrId === 'object' ? String(userOrId.email || '').trim().toLowerCase() : ''

  if (isFirebaseConfigured) {
    try {
      if (lookupId) {
        const docRef = doc(db, 'employees', lookupId)
        const docSnap = await getDoc(docRef)
        if (docSnap.exists()) {
          return { id: docSnap.id, ...docSnap.data() }
        }
      }
      if (lookupEmail) {
        const emailQuery = query(
          collection(db, 'employees'),
          where('email', '==', lookupEmail),
          limit(1),
        )
        const emailSnap = await getDocs(emailQuery)
        if (!emailSnap.empty) {
          const employee = emailSnap.docs[0]
          return { id: employee.id, ...employee.data() }
        }
      }
      return null
    } catch (error) {
      if (error.code === 'permission-denied') {
        throw new Error('Insufficient permissions - employee profile not found. Ask admin to create your account with the exact Google email used for sign-in.')
      }
      console.warn('Error getting employee profile:', error)
      return null
    }
  }

  const employees = readJson(DEMO_USERS_KEY, [])
  return employees.find((emp) =>
    (lookupId && (String(emp.id) === lookupId || String(emp.uid) === lookupId || String(emp.userId) === lookupId)) ||
    (lookupEmail && String(emp.email || '').toLowerCase() === lookupEmail)
  ) || null
}

function normalizeRoleConfig(role) {
  if (!role) return null
  return {
    roleName: String(role.roleName || role.name || '').trim(),
    payType: String(role.payType || 'DAILY').toUpperCase(),
    rate: Number(role.rate || 0) || 0,
    updatedAt: role.updatedAt || role.createdAt || null,
  }
}

export async function getRoles() {
  if (!isFirebaseConfigured) {
    return []
  }

  const snapshot = await getDocs(query(collection(db, 'roles'), orderBy('roleName', 'asc')))
  return snapshot.docs.map((docItem) => ({ id: docItem.id, ...normalizeRoleConfig(docItem.data()) }))
}

export async function getRoleByName(roleName) {
  if (!roleName) return null
  if (!isFirebaseConfigured) {
    return null
  }

  const snapshot = await getDocs(
    query(
      collection(db, 'roles'),
      where('roleName', '==', String(roleName).trim()),
      limit(1),
    ),
  )
  if (snapshot.empty) return null
  return normalizeRoleConfig(snapshot.docs[0].data())
}

export async function createRole({ roleName, payType, rate, createdBy }) {
  if (!isFirebaseConfigured) {
    throw new Error('Firestore is not configured.')
  }
  if (!roleName) {
    throw new Error('Role name is required.')
  }
  const normalized = String(roleName).trim()
  if (!normalized) {
    throw new Error('Role name is required.')
  }
  await setDoc(doc(db, 'roles', normalized), {
    roleName: normalized,
    payType: String(payType || 'DAILY').toUpperCase(),
    rate: Number(rate || 0),
    createdBy: createdBy || null,
    updatedBy: createdBy || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  await createAuditLog('role.created', createdBy, { roleName: normalized, payType: String(payType || 'DAILY').toUpperCase(), rate: Number(rate || 0) })
}

export async function updateRole(roleName, updates, updatedBy) {
  if (!isFirebaseConfigured) {
    throw new Error('Firestore is not configured.')
  }
  if (!roleName) {
    throw new Error('Role name is required.')
  }
  const normalized = String(roleName).trim()
  const payload = {
    updatedBy: updatedBy || null,
    updatedAt: serverTimestamp(),
  }
  if (updates.payType) payload.payType = String(updates.payType).toUpperCase()
  if (updates.rate !== undefined) payload.rate = Number(updates.rate || 0)
  await setDoc(doc(db, 'roles', normalized), payload, { merge: true })
  await createAuditLog('role.updated', updatedBy, { roleName: normalized, updates })
}

export async function deleteRole(roleName, deletedBy) {
  if (!isFirebaseConfigured) {
    throw new Error('Firestore is not configured.')
  }
  if (!roleName) {
    throw new Error('Role name is required.')
  }
  const normalized = String(roleName).trim()
  await deleteDoc(doc(db, 'roles', normalized))
  await createAuditLog('role.deleted', deletedBy, { roleName: normalized })
}

export async function createAuditLog(eventType, userId, payload = {}) {
  if (!isFirebaseConfigured) {
    return
  }
  await addDoc(collection(db, 'audit_logs'), {
    eventType: String(eventType || 'unknown'),
    userId: userId || null,
    payload,
    createdAt: serverTimestamp(),
  })
}

export async function getAuditLogs(limitRows = 100) {
  if (!isFirebaseConfigured) {
    return []
  }
  const snapshot = await getDocs(query(collection(db, 'audit_logs'), orderBy('createdAt', 'desc'), limit(limitRows)))
  return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
}

export async function createEmployeeByAdmin({
  name,
  email,
  role = 'employee',
  roleName = '',
  active = true,
  dailyRate = 0,
  allowedHolidays,
  createdBy,
}) {
  if (isFirebaseConfigured) {
    if (!createdBy) {
      throw new Error('Admin user is required.')
    }

    const rules = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
    const fallbackHolidays = Number(rules?.payrollRules?.defaultAllowedHolidays ?? DEFAULT_SETTINGS.payrollRules.defaultAllowedHolidays) || 0
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const cleanName = String(name || '').trim()
    const cleanRoleName = String(roleName || '').trim()

    if (!normalizedEmail || !cleanName) {
      throw new Error('Name and email are required.')
    }

    const duplicateQuery = query(
      collection(db, 'employees'),
      where('email', '==', normalizedEmail),
      where('active', '==', true),
      limit(1),
    )
    const duplicateSnap = await getDocs(duplicateQuery)
    if (!duplicateSnap.empty) {
      throw new Error('Employee with this email already exists.')
    }

    await addDoc(collection(db, 'employees'), {
      name: cleanName,
      email: normalizedEmail,
      role,
      roleName: cleanRoleName,
      active,
      dailyRate: Number(dailyRate) || 0,
      allowedHolidays: Number(allowedHolidays ?? fallbackHolidays) || 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy,
    })
    return
  }

  const users = readJson(DEMO_USERS_KEY, [])
  const rules = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
  const fallbackHolidays = Number(rules?.payrollRules?.defaultAllowedHolidays ?? DEFAULT_SETTINGS.payrollRules.defaultAllowedHolidays) || 0
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const cleanName = String(name || '').trim()
  const cleanRoleName = String(roleName || '').trim()
  if (!normalizedEmail || !cleanName) {
    throw new Error('Name and email are required.')
  }
  if (users.some((user) => user.email === normalizedEmail)) {
    throw new Error('Employee with this email already exists.')
  }
  users.push({
    id: crypto.randomUUID(),
    email: normalizedEmail,
    name: cleanName,
    role,
    roleName: cleanRoleName,
    active,
    dailyRate: Number(dailyRate) || 0,
    allowedHolidays: Number(allowedHolidays ?? fallbackHolidays) || 0,
  })
  writeJson(DEMO_USERS_KEY, users)
}

export async function updateEmployeeByAdmin({
  id,
  name,
  email,
  role = 'employee',
  roleName = '',
  active = true,
  dailyRate = 0,
  allowedHolidays,
  updatedBy,
}) {
  if (!id) {
    throw new Error('Employee id is required.')
  }

  const normalizedEmail = String(email || '').trim().toLowerCase()
  const cleanName = String(name || '').trim()
  const cleanRoleName = String(roleName || '').trim()

  if (!normalizedEmail || !cleanName) {
    throw new Error('Name and email are required.')
  }

  if (isFirebaseConfigured) {
    const rules = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
    const fallbackHolidays = Number(rules?.payrollRules?.defaultAllowedHolidays ?? DEFAULT_SETTINGS.payrollRules.defaultAllowedHolidays) || 0
    await setDoc(
      doc(db, 'employees', id),
      {
        name: cleanName,
        email: normalizedEmail,
        role,
        roleName: cleanRoleName,
        active,
        dailyRate: Number(dailyRate) || 0,
        allowedHolidays: Number(allowedHolidays ?? fallbackHolidays) || 0,
        updatedAt: serverTimestamp(),
        updatedBy: updatedBy || null,
      },
      { merge: true },
    )
    return
  }

  const users = readJson(DEMO_USERS_KEY, [])
  const duplicate = users.find((employee) => employee.id !== id && employee.email === normalizedEmail && employee.active !== false)
  if (duplicate) {
    throw new Error('Employee with this email already exists.')
  }

  const nextUsers = users.map((employee) =>
    employee.id === id
      ? {
          ...employee,
          name: cleanName,
          email: normalizedEmail,
          role,
          roleName: cleanRoleName,
          active,
          dailyRate: Number(dailyRate) || 0,
          allowedHolidays: Number(allowedHolidays ?? employee.allowedHolidays ?? DEFAULT_SETTINGS.payrollRules.defaultAllowedHolidays) || 0,
        }
      : employee,
  )
  writeJson(DEMO_USERS_KEY, nextUsers)
}

export async function removeEmployeeByAdmin(id, updatedBy) {
  if (!id) {
    throw new Error('Employee id is required.')
  }

  if (isFirebaseConfigured) {
    await setDoc(
      doc(db, 'employees', id),
      {
        active: false,
        updatedAt: serverTimestamp(),
        updatedBy: updatedBy || null,
      },
      { merge: true },
    )
    return
  }

  const users = readJson(DEMO_USERS_KEY, [])
  const nextUsers = users.map((employee) => (employee.id === id ? { ...employee, active: false } : employee))
  writeJson(DEMO_USERS_KEY, nextUsers)
}

export async function createTvDisplaySession(user, refreshSeconds) {
  const currentSettings = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
  const nextRefresh = normalizeRefreshIntervalSeconds(refreshSeconds || currentSettings.refreshInterval || APP_CONFIG.tokenRefreshSeconds)

  if (!isAdminUser(user)) {
    throw new Error('Only admin can create a TV display session.')
  }

  if (isFirebaseConfigured) {
    const createSession = httpsCallable(cloudFunctions, 'createTvDisplaySession')
    const result = await createSession({
      refreshSeconds: nextRefresh,
      origin: window.location.origin,
    })
    return result.data
  }

  const existing = await getActiveTvDisplaySessionRecord()
  const sessionId = existing?.id || createToken()
  const payload = buildTvDisplaySessionResult(sessionId, user.uid || user.id, nextRefresh)

  const sessions = readJson(DEMO_TV_SESSIONS_KEY, []).filter((item) => item.id !== sessionId)
  sessions.unshift(payload)
  writeJson(DEMO_TV_SESSIONS_KEY, sessions.slice(0, 20))
  return payload
}

export async function issueTvToken(userOrOptions, refreshSeconds) {
  const currentSettings = await getAdminSettings().catch(() => DEFAULT_SETTINGS)
  const ttl = normalizeRefreshIntervalSeconds(refreshSeconds || currentSettings.refreshInterval || APP_CONFIG.tokenRefreshSeconds)
  const actor = userOrOptions && typeof userOrOptions === 'object' && 'displaySessionToken' in userOrOptions
    ? userOrOptions
    : { user: userOrOptions }
  const user = actor.user || null
  const displaySessionToken = String(actor.displaySessionToken || '').trim()
  let displaySession = null

  if (!isFirebaseConfigured && displaySessionToken) {
    displaySession = await getTvDisplaySessionRecord(displaySessionToken)
    if (!displaySession || displaySession.active === false || Number(displaySession.expiresAtMs || 0) < Date.now()) {
      throw new Error('TV display session expired. Re-open the TV link from admin.')
    }
  }

  if (isFirebaseConfigured) {
    const issueToken = httpsCallable(cloudFunctions, 'issueTvToken')
    const result = await issueToken({
      branchId: APP_CONFIG.branchId,
      refreshSeconds: ttl,
      displaySessionToken: displaySessionToken || null,
    })
    return {
      ...result.data,
      active: true,
      scansCount: 0,
    }
  }

  const token = createToken()
  const issuedAtMs = Date.now()
  const expiresAtMs = issuedAtMs + ttl * 1000
  const issuedAt = new Date(issuedAtMs).toISOString()
  const expiresAt = new Date(expiresAtMs).toISOString()
  const payload = {
    token,
    issuedAt,
    expiresAt,
    issuedAtMs,
    expiresAtMs,
    branchId: APP_CONFIG.branchId,
    active: true,
    scansCount: 0,
    issuedBy: user?.uid || user?.id || displaySession?.issuedBy || 'tv-session',
    displaySessionId: displaySession?.id || displaySessionToken || null,
  }
  writeJson(DEMO_TV_KEY, payload)

  const history = readJson(DEMO_TOKENS_KEY, [])
  const marked = history.map((item) => ({ ...item, active: false }))
  marked.unshift(payload)
  writeJson(DEMO_TOKENS_KEY, marked.slice(0, 20))

  return payload
}

export function formatRole(user) {
  if (!user) return 'Guest'

  if (user.role) {
    return user.role
  }

  return 'employee'
}

export function isAdminUser(user) {
  return formatRole(user) === 'admin'
}

export function toExportRows(records) {
  return records.map((record) => ({
    Date: record.date,
    Employee: record.employeeName || record.userName || record.userId,
    'Check In': record.checkInAt || '-',
    'Check Out': record.checkOutAt || '-',
    Status: record.late ? 'Late' : record.checkInAt ? 'On Time' : 'Absent',
  }))
}

export function toLogExportRows(records) {
  return records.map((record, index) => ({
    '#': index + 1,
    Name: record.employeeName || '-',
    UID: record.userId || '-',
    Type: record.action === 'checkIn' ? 'Check In' : 'Check Out',
    Status: record.action === 'checkIn' ? (record.late ? 'Late' : 'On Time') : '-',
    Date: record.date || '-',
    Time: record.clientTs || '-',
    GPS: record.gps || '-',
    Token: record.token || '-',
  }))
}

// Token management functions
export async function revokeToken(tokenId) {
  if (isFirebaseConfigured) {
    const tokenRef = doc(db, 'qr_tokens', tokenId)
    await setDoc(tokenRef, { active: false, revokedAt: serverTimestamp() }, { merge: true })
    return
  }
  
  const history = readJson(DEMO_TOKENS_KEY, [])
  const idx = history.findIndex((t) => t.token === tokenId)
  if (idx >= 0) {
    history[idx].active = false
  }
  writeJson(DEMO_TOKENS_KEY, history)
}

export async function deleteToken(tokenId) {
  if (isFirebaseConfigured) {
    await deleteDoc(doc(db, 'qr_tokens', tokenId))
    return
  }
  
  const history = readJson(DEMO_TOKENS_KEY, [])
  const filtered = history.filter((t) => t.token !== tokenId)
  writeJson(DEMO_TOKENS_KEY, filtered)
}

export async function bulkDeleteExpiredTokens() {
  if (isFirebaseConfigured) {
    const query = query(collection(db, 'qr_tokens'), where('active', '==', false), where('expiresAtMs', '<', Date.now()))
    const snapshot = await getDocs(query)
    const batch = [];
    snapshot.docs.forEach((docItem) => {
      batch.push(deleteDoc(docItem.ref))
    })
    await Promise.all(batch)
    return snapshot.docs.length
  }
  
  const history = readJson(DEMO_TOKENS_KEY, [])
  const filtered = history.filter((t) => t.active !== false || new Date(t.expiresAt).getTime() >= Date.now())
  const deleted = history.length - filtered.length
  writeJson(DEMO_TOKENS_KEY, filtered)
  return deleted
}

export async function getTokenStats(dateRangeStart, dateRangeEnd) {
  if (isFirebaseConfigured) {
    const logsQuery = query(
      collection(db, 'attendance_logs'),
      where('clientTs', '>=', dateRangeStart),
      where('clientTs', '<=', dateRangeEnd),
      orderBy('clientTs', 'asc'),
    )
    const snapshot = await getDocs(logsQuery)
    const logs = snapshot.docs.map((doc) => doc.data())
    
    // Aggregate scan activity by hour
    const byHour = new Map()
    logs.forEach((log) => {
      if (!log.clientTs) return
      const hourKey = new Date(log.clientTs).toISOString().slice(0, 13)
      byHour.set(hourKey, (byHour.get(hourKey) || 0) + 1)
    })
    
    const hours = Array.from(byHour.entries()).map(([hour, count]) => ({ hour, count }))
    const peakHour = hours.length > 0 ? hours.reduce((max, h) => h.count > max.count ? h : max) : null
    const avgPerHour = logs.length / Math.max(1, hours.length)
    
    return {
      totalScans: logs.length,
      byHour: hours,
      peakHour,
      avgPerHour: Math.round(avgPerHour * 100) / 100,
    }
  }
  
  // Demo mode
  const logs = readJson('scantrack_demo_action_logs', [])
  const filtered = logs.filter((log) => log.clientTs >= dateRangeStart && log.clientTs <= dateRangeEnd)
  
  const byHour = new Map()
  filtered.forEach((log) => {
    if (!log.clientTs) return
    const hourKey = new Date(log.clientTs).toISOString().slice(0, 13)
    byHour.set(hourKey, (byHour.get(hourKey) || 0) + 1)
  })
  
  const hours = Array.from(byHour.entries()).map(([hour, count]) => ({ hour, count }))
  const peakHour = hours.length > 0 ? hours.reduce((max, h) => h.count > max.count ? h : max) : null
  const avgPerHour = filtered.length / Math.max(1, hours.length)
  
  return {
    totalScans: filtered.length,
    byHour: hours,
    peakHour,
    avgPerHour: Math.round(avgPerHour * 100) / 100,
  }
}

export function formatAuthName(user) {
  return user?.displayName || user?.name || user?.email || 'Employee'
}

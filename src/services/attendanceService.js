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
import { APP_CONFIG } from '../config'
import { auth, db, googleProvider, isFirebaseConfigured } from '../lib/firebase'
import { createToken, getTodayKey, humanTime, isLate, now } from '../lib/time'

const DEMO_USERS_KEY = 'scantrack_demo_users'
const DEMO_LOGS_KEY = 'scantrack_demo_logs'
const DEMO_TV_KEY = 'scantrack_demo_tv_token'
const DEMO_TOKENS_KEY = 'scantrack_demo_tokens'
const DEMO_SETTINGS_KEY = 'scantrack_demo_settings'
const DEMO_SESSION_KEY = 'scantrack_demo_session'
const AUTH_ERROR_KEY = 'scantrack_auth_error'

const DEFAULT_SETTINGS = {
  workStart: APP_CONFIG.workStart,
  workEnd: '18:00',
  graceMins: APP_CONFIG.gracePeriodMinutes,
  lateAlerts: true,
  gpsVerify: false,
  dupePrevention: true,
  employeeDarkMode: false,
  refreshInterval: APP_CONFIG.tokenRefreshSeconds,
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

  const profileRef = doc(db, 'employees', firebaseUser.uid)
  let profile = null

  const profileSnap = await getDoc(profileRef).catch(() => null)
  if (profileSnap?.exists()) {
    profile = profileSnap.data()
  }

  if (!profile && firebaseUser.email) {
    const inviteQuery = query(
      collection(db, 'employees'),
      where('email', '==', firebaseUser.email),
      where('active', '==', true),
      limit(1),
    )
    const inviteSnap = await getDocs(inviteQuery).catch(() => null)
    const invited = inviteSnap?.docs?.[0]?.data() || null

    if (invited) {
      await setDoc(
        profileRef,
        {
          name: invited.name || safeName(firebaseUser.email, firebaseUser.displayName),
          email: firebaseUser.email || '',
          role: invited.role || 'employee',
          active: true,
          updatedAt: serverTimestamp(),
          createdAt: invited.createdAt || serverTimestamp(),
        },
        { merge: true },
      ).catch(() => null)

      const claimed = await getDoc(profileRef).catch(() => null)
      if (claimed?.exists()) {
        profile = claimed.data()
      }
    }
  }

  if (!profile) {
    setAuthError('Access denied. Your account is not registered by admin yet.')
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
    email: firebaseUser.email,
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
            email: firebaseUser.email,
            displayName: firebaseUser.displayName,
            name: profile?.name || safeName(firebaseUser.email, firebaseUser.displayName),
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

  if (isFirebaseConfigured) {
    const uid = user.uid || user.id
    const date = getTodayKey()
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
      const lateFlag = isLate(timestamp)

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
            checkInAt: timestamp,
            checkOutAt: null,
            late: lateFlag,
            branchId: tokenData.branchId || APP_CONFIG.branchId,
            checkInToken: token,
            checkOutToken: null,
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

        transaction.set(
          dailyRef,
          {
            checkOutAt: timestamp,
            checkOutToken: token,
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
      gps: null,
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

  const date = getTodayKey()
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
      checkInAt: timestamp,
      checkOutAt: null,
      late: isLate(timestamp),
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
      gps: null,
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

  record.checkOutAt = timestamp
  record.checkOutToken = token
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
    gps: null,
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

export async function getAdminSettings() {
  if (isFirebaseConfigured) {
    const settingsRef = doc(db, 'settings', 'attendance')
    const snapshot = await getDoc(settingsRef)
    if (!snapshot.exists()) {
      return DEFAULT_SETTINGS
    }
    return { ...DEFAULT_SETTINGS, ...snapshot.data() }
  }

  return { ...DEFAULT_SETTINGS, ...readJson(DEMO_SETTINGS_KEY, DEFAULT_SETTINGS) }
}

export async function saveAdminSettings(payload) {
  if (isFirebaseConfigured) {
    const settingsRef = doc(db, 'settings', 'attendance')
    await setDoc(settingsRef, { ...payload, updatedAt: serverTimestamp() }, { merge: true })
    return
  }

  writeJson(DEMO_SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...payload })
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
      return snapshot.docs.map((docItem) => ({ id: docItem.id, ...docItem.data() }))
    } catch (error) {
      if (error?.code === 'permission-denied') {
        throw new Error('Cannot read employees. Ensure your user has admin role in employees collection.')
      }

      throw error
    }
  }

  return readJson(DEMO_USERS_KEY, [])
}

export async function createEmployeeByAdmin({ name, email, role = 'employee', active = true, createdBy }) {
  if (isFirebaseConfigured) {
    if (!createdBy) {
      throw new Error('Admin user is required.')
    }

    const normalizedEmail = String(email || '').trim().toLowerCase()
    const cleanName = String(name || '').trim()

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
      active,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdBy,
    })
    return
  }

  const users = readJson(DEMO_USERS_KEY, [])
  const normalizedEmail = String(email || '').trim().toLowerCase()
  const cleanName = String(name || '').trim()
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
    active,
  })
  writeJson(DEMO_USERS_KEY, users)
}

export async function issueTvToken(user, refreshSeconds = APP_CONFIG.tokenRefreshSeconds) {
  if (isFirebaseConfigured) {
    if (!isAdminUser(user)) {
      throw new Error('Only admin can issue TV tokens. Set role=admin in employees collection for this account.')
    }

    const token = createToken()
    const issuedAtMs = Date.now()
    const expiresAtMs = issuedAtMs + refreshSeconds * 1000
    const payload = {
      token,
      branchId: APP_CONFIG.branchId,
      active: true,
      issuedBy: user.uid || user.id,
      issuedAtMs,
      expiresAtMs,
      scansCount: 0,
      issuedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }

    await setDoc(doc(db, 'qr_tokens', token), payload)

    return {
      token,
      branchId: APP_CONFIG.branchId,
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      issuedAtMs,
      active: true,
      scansCount: 0,
    }
  }

  const token = createToken()
  const issuedAtMs = Date.now()
  const expiresAtMs = issuedAtMs + refreshSeconds * 1000
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

export function formatAuthName(user) {
  return user?.displayName || user?.name || user?.email || 'Employee'
}

import { initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

initializeApp()

const db = getFirestore()

function requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Please sign in.')
  }

  return request.auth.uid
}

function requireAdmin(request) {
  const uid = requireAuth(request)
  if (request.auth.token.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin access required.')
  }

  return uid
}

function todayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function makeToken() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function getEmployee(uid) {
  const snap = await db.collection('employees').doc(uid).get()
  if (!snap.exists) {
    throw new HttpsError('failed-precondition', 'Employee profile missing.')
  }

  return snap.data()
}

async function getDailyRecord(uid, date) {
  const id = `${uid}_${date}`
  const ref = db.collection('attendance_daily').doc(id)
  const snap = await ref.get()

  return {
    id,
    ref,
    exists: snap.exists,
    data: snap.exists ? snap.data() : null,
  }
}

export const issueTvToken = onCall(async (request) => {
  requireAdmin(request)

  const branchId = request.data?.branchId || 'main-floor'
  const token = makeToken()
  const now = Date.now()
  const expiresAt = now + 60 * 1000

  await db.collection('qr_tokens').doc(token).set({
    token,
    branchId,
    active: true,
    usedBy: null,
    issuedAt: FieldValue.serverTimestamp(),
    expiresAtMs: expiresAt,
  })

  return {
    token,
    branchId,
    expiresAt: new Date(expiresAt).toISOString(),
    issuedAt: new Date(now).toISOString(),
  }
})

export const recordAttendance = onCall(async (request) => {
  const uid = requireAuth(request)
  const action = request.data?.action
  const token = String(request.data?.token || '').toUpperCase()

  if (!['checkIn', 'checkOut'].includes(action)) {
    throw new HttpsError('invalid-argument', 'Invalid action.')
  }

  if (!token) {
    throw new HttpsError('invalid-argument', 'Token is required.')
  }

  const tokenRef = db.collection('qr_tokens').doc(token)
  const tokenSnap = await tokenRef.get()

  if (!tokenSnap.exists) {
    throw new HttpsError('failed-precondition', 'Invalid QR token.')
  }

  const tokenData = tokenSnap.data()
  if (!tokenData.active || tokenData.expiresAtMs < Date.now()) {
    throw new HttpsError('failed-precondition', 'QR token expired.')
  }

  if (tokenData.usedBy && tokenData.usedBy !== uid) {
    throw new HttpsError('already-exists', 'QR token already used.')
  }

  const employee = await getEmployee(uid)
  const date = todayKey()
  const ts = new Date().toISOString()

  const daily = await getDailyRecord(uid, date)

  if (action === 'checkIn') {
    if (daily.data?.checkInAt) {
      throw new HttpsError('already-exists', 'You already checked in today.')
    }

    await daily.ref.set({
      userId: uid,
      date,
      employeeName: employee.name || employee.email || uid,
      checkInAt: ts,
      checkOutAt: null,
      late: false,
      branchId: tokenData.branchId,
      checkInToken: token,
      checkOutToken: null,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: daily.exists ? daily.data.createdAt : FieldValue.serverTimestamp(),
    }, { merge: true })
  }

  if (action === 'checkOut') {
    if (!daily.data?.checkInAt) {
      throw new HttpsError('failed-precondition', 'You need to check in first.')
    }

    if (daily.data?.checkOutAt) {
      throw new HttpsError('already-exists', 'You already checked out today.')
    }

    await daily.ref.set(
      {
        checkOutAt: ts,
        checkOutToken: token,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
  }

  await db.collection('attendance_logs').add({
    userId: uid,
    employeeName: employee.name || employee.email || uid,
    action,
    token,
    branchId: tokenData.branchId,
    createdAt: FieldValue.serverTimestamp(),
    clientTs: ts,
    ip: request.rawRequest.ip || null,
  })

  await tokenRef.set(
    {
      active: false,
      usedBy: uid,
      usedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )

  return {
    ok: true,
    action,
    timestamp: ts,
    message: `${action === 'checkIn' ? 'Check-In' : 'Check-Out'} recorded successfully.`,
  }
})

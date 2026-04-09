import { APP_CONFIG } from '../config'

const formatDate = (date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_CONFIG.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)

const formatTime = (date) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: APP_CONFIG.timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date)

export function now() {
  return new Date()
}

export function getTodayKey() {
  return formatDate(now())
}

export function humanTime(date) {
  return formatTime(date)
}

export function humanDateTime(iso) {
  const date = new Date(iso)
  return `${formatDate(date)} ${formatTime(date)}`
}

export function isLate(isoDateTime) {
  const date = new Date(isoDateTime)
  const [hours, minutes] = APP_CONFIG.workStart.split(':').map(Number)

  const cutoff = new Date(date)
  cutoff.setHours(hours, minutes + APP_CONFIG.gracePeriodMinutes, 0, 0)
  return date.getTime() > cutoff.getTime()
}

export function createToken(size = APP_CONFIG.tokenLength) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: size })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('')
}

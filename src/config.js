export const APP_CONFIG = {
  companyName: import.meta.env.VITE_COMPANY_NAME || 'Wybe Fashion',
  branchId: import.meta.env.VITE_BRANCH_ID || 'main-floor',
  timezone: import.meta.env.VITE_TIMEZONE || 'Asia/Colombo',
  workStart: import.meta.env.VITE_WORK_START || '09:00',
  gracePeriodMinutes: Number(import.meta.env.VITE_GRACE_MINUTES || 10),
  tokenRefreshSeconds: Number(import.meta.env.VITE_TOKEN_REFRESH_SECONDS || 60),
  tokenLength: Number(import.meta.env.VITE_TOKEN_LENGTH || 8),
  shopGps: {
    lat: Number(import.meta.env.VITE_SHOP_LAT || 6.9271), // Colombo default
    lng: Number(import.meta.env.VITE_SHOP_LNG || 79.8612),
  },
  verificationRadiusMeters: Number(import.meta.env.VITE_VERIFY_RADIUS || 100),
}

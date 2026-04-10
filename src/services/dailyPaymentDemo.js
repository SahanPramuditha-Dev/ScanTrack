const DEMO_DAILY_PAYMENTS_KEY = 'scantrack_demo_daily_payments';

function getMonthRange(monthKey) {
  const month = String(monthKey || '').slice(0, 7)
  const endDate = new Date(`${month}-01T00:00:00.000Z`)
  endDate.setUTCMonth(endDate.getUTCMonth() + 1)
  endDate.setUTCDate(0)
  return {
    start: `${month}-01`,
    end: endDate.toISOString().slice(0, 10),
  }
}

export function readDemoDailyPayments() {
  return JSON.parse(localStorage.getItem(DEMO_DAILY_PAYMENTS_KEY) || '[]');
}

export function writeDemoDailyPayments(payments) {
  localStorage.setItem(DEMO_DAILY_PAYMENTS_KEY, JSON.stringify(payments));
}

export function upsertDemoDailyPayment(record) {
  const payments = readDemoDailyPayments();
  const key = `${record.userId}_${record.date}`;
  const next = payments.filter((r) => `${r.userId}_${r.date}` !== key);
  next.unshift({ ...record, id: key });
  writeDemoDailyPayments(next.slice(0, 1000));
}

export function aggregateDemoDailyPaymentsForMonth(monthKey, userId = null) {
  const payments = readDemoDailyPayments();
  const { start, end } = getMonthRange(monthKey);
  const filtered = payments.filter(p => p.date >= start && p.date <= end && (!userId || p.userId === userId));
  const byUser = {};
  filtered.forEach(p => {
    if (!byUser[p.userId]) byUser[p.userId] = { totalDailySalary: 0, totalDeductions: 0, count: 0 };
    byUser[p.userId].totalDailySalary += Number(p.dailySalary || 0);
    byUser[p.userId].totalDeductions += Number(p.totalDeductions || 0);
    byUser[p.userId].count += 1;
  });
  return byUser;
}

import { useMemo } from 'react'
import { getTodayKey, formatDateKey } from '../lib/time'

// Hook to process analytics data for dashboard
export function useDashboardAnalytics(logs, employees, salaryRows, dashboardRange, date) {
  return useMemo(() => {
    // Calculate date range
    const days = dashboardRange === 'month' ? 30 : 7
    const endDate = new Date(`${date}T12:00:00.000Z`)
    const startDate = new Date(endDate)
    startDate.setDate(endDate.getDate() - days + 1)

    // Filter logs for the range
    const rangeLogs = logs.filter(log => {
      const logDate = new Date(`${log.date}T12:00:00.000Z`)
      return logDate >= startDate && logDate <= endDate
    })

    // KPI Calculations
    const totalEmployees = employees.filter(emp => emp.active !== false).length
    const totalCheckIns = rangeLogs.filter(log => log.action === 'checkIn').length
    const lateArrivals = rangeLogs.filter(log => log.action === 'checkIn' && log.late).length
    const attendanceRate = totalCheckIns > 0 ? Math.round(((totalCheckIns - lateArrivals) / totalCheckIns) * 100) : 0

    // Calculate total payroll for current month
    const currentMonth = date.slice(0, 7)
    const currentMonthPayroll = salaryRows
      .filter(row => row.month === currentMonth)
      .reduce((sum, row) => sum + Number(row.finalSalary || 0), 0)

    const kpis = {
      totalEmployees: {
        title: 'Total Employees',
        value: totalEmployees,
        subtitle: 'Active staff members',
        color: 'primary'
      },
      attendanceRate: {
        title: 'Attendance Rate',
        value: `${attendanceRate}%`,
        subtitle: `${totalCheckIns - lateArrivals}/${totalCheckIns} on time`,
        trend: 2.5, // Mock trend data
        color: 'success'
      },
      lateArrivals: {
        title: 'Late Arrivals',
        value: lateArrivals,
        subtitle: 'This period',
        trend: -1.2,
        color: 'warning'
      },
      totalPayroll: {
        title: 'Total Payroll',
        value: `$${currentMonthPayroll.toLocaleString()}`,
        subtitle: currentMonth,
        trend: 3.1,
        color: 'info'
      }
    }

    // Attendance Trend Data
    const attendanceTrend = []
    for (let i = days - 1; i >= 0; i--) {
      const currentDate = new Date(endDate)
      currentDate.setDate(endDate.getDate() - i)
      const dateKey = formatDateKey(currentDate)

      const dayLogs = rangeLogs.filter(log => log.date === dateKey)
      const checkIns = dayLogs.filter(log => log.action === 'checkIn').length
      const late = dayLogs.filter(log => log.action === 'checkIn' && log.late).length

      attendanceTrend.push({
        date: dateKey,
        checkIns,
        late,
        onTime: checkIns - late
      })
    }

    // Late Arrivals by Hour
    const lateByHour = Array.from({ length: 24 }, (_, hour) => ({ hour: `${hour}:00`, count: 0 }))
    rangeLogs
      .filter(log => log.action === 'checkIn' && log.late)
      .forEach(log => {
        const hour = new Date(log.clientTs).getHours()
        lateByHour[hour].count++
      })

    // Employee Status Data
    const activeEmployees = employees.filter(emp => emp.active !== false).length
    const inactiveEmployees = employees.filter(emp => emp.active === false).length
    const checkedInToday = employees.filter(emp => emp.checkInAt && emp.date === date).length

    const employeeStatusData = [
      { name: 'Active', value: activeEmployees },
      { name: 'Checked In', value: checkedInToday },
      { name: 'Inactive', value: inactiveEmployees }
    ]

    // Salary Distribution (mock data for now)
    const salaryData = [
      { range: '$0-2000', count: 5 },
      { range: '$2000-4000', count: 12 },
      { range: '$4000-6000', count: 8 },
      { range: '$6000+', count: 3 }
    ]

    // Payroll Data (last 6 months)
    const payrollData = []
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date()
      monthDate.setMonth(monthDate.getMonth() - i)
      const monthKey = monthDate.toISOString().slice(0, 7)

      const monthPayroll = salaryRows
        .filter(row => row.month === monthKey)
        .reduce((sum, row) => ({
          totalPayroll: sum.totalPayroll + Number(row.finalSalary || 0),
          totalDeductions: sum.totalDeductions + Number(row.deductions || 0),
          totalBonus: sum.totalBonus + Number(row.bonus || 0)
        }), { totalPayroll: 0, totalDeductions: 0, totalBonus: 0 })

      payrollData.push({
        month: monthDate.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
        ...monthPayroll
      })
    }

    return {
      kpis,
      attendanceTrend,
      lateByTime: lateByHour.filter(item => item.count > 0),
      employeeStatusData,
      salaryData,
      payrollData
    }
  }, [logs, employees, salaryRows, dashboardRange, date])
}
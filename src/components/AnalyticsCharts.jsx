import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

// KPI Card Component
export function KpiCard({ title, value, subtitle, trend, color = 'primary' }) {
  return (
    <div className={`kpi-card kpi-${color}`}>
      <div className="kpi-header">
        <h3 className="kpi-title">{title}</h3>
        {trend && (
          <span className={`kpi-trend ${trend > 0 ? 'positive' : trend < 0 ? 'negative' : 'neutral'}`}>
            {trend > 0 ? '↗' : trend < 0 ? '↘' : '→'} {Math.abs(trend)}%
          </span>
        )}
      </div>
      <div className="kpi-value">{value}</div>
      {subtitle && <div className="kpi-subtitle">{subtitle}</div>}
    </div>
  )
}

// Attendance Trend Chart
export function AttendanceTrendChart({ data }) {
  return (
    <div className="chart-container">
      <h4>Attendance Trend</h4>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Area type="monotone" dataKey="checkIns" stackId="1" stroke="#4CAF50" fill="#4CAF50" />
          <Area type="monotone" dataKey="late" stackId="1" stroke="#FF9800" fill="#FF9800" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// Late Arrivals Chart
export function LateArrivalsChart({ data }) {
  return (
    <div className="chart-container">
      <h4>Late Arrivals by Hour</h4>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <XAxis dataKey="hour" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="count" fill="#FF5722" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Employee Status Distribution
export function EmployeeStatusChart({ data }) {
  const COLORS = ['#4CAF50', '#FF9800', '#2196F3', '#9C27B0']

  return (
    <div className="chart-container">
      <h4>Employee Status</h4>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            outerRadius={80}
            fill="#8884d8"
            dataKey="value"
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

// Salary Distribution Chart
export function SalaryDistributionChart({ data }) {
  return (
    <div className="chart-container">
      <h4>Salary Distribution</h4>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <XAxis dataKey="range" />
          <YAxis />
          <Tooltip />
          <Bar dataKey="count" fill="#3F51B5" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Payroll Summary Chart
export function PayrollSummaryChart({ data, height = 400 }) {
  return (
    <div className="chart-container">
      <h4>Payroll Summary</h4>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <XAxis dataKey="month" />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="totalPayroll" stroke="#4CAF50" strokeWidth={2} />
          <Line type="monotone" dataKey="totalDeductions" stroke="#FF5722" strokeWidth={2} />
          <Line type="monotone" dataKey="totalBonus" stroke="#2196F3" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// Department Performance Chart
export function DepartmentPerformanceChart({ data }) {
  return (
    <div className="chart-container">
      <h4>Department Performance</h4>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} layout="horizontal">
          <XAxis type="number" />
          <YAxis dataKey="department" type="category" width={100} />
          <Tooltip />
          <Bar dataKey="attendanceRate" fill="#4CAF50" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Overtime Trends Chart
export function OvertimeTrendsChart({ data }) {
  return (
    <div className="chart-container">
      <h4>Overtime Trends</h4>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={data}>
          <XAxis dataKey="date" />
          <YAxis />
          <Tooltip />
          <Area type="monotone" dataKey="overtimeHours" stroke="#FF9800" fill="#FF9800" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
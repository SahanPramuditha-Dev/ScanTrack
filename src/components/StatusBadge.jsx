// StatusBadge Component for consistent status indicators
export function StatusBadge({ status, variant = 'default', size = 'medium', className = '' }) {
  const getStatusConfig = (status, variant) => {
    const configs = {
      // Status variants
      present: { label: 'Present', color: 'success', icon: '✓' },
      absent: { label: 'Absent', color: 'danger', icon: '✗' },
      late: { label: 'Late', color: 'warning', icon: '⏰' },
      'on-time': { label: 'On Time', color: 'success', icon: '✓' },
      pending: { label: 'Pending', color: 'warning', icon: '⏳' },
      approved: { label: 'Approved', color: 'success', icon: '✓' },
      rejected: { label: 'Rejected', color: 'danger', icon: '✗' },
      active: { label: 'Active', color: 'success', icon: '●' },
      inactive: { label: 'Inactive', color: 'neutral', icon: '●' },
      checkedIn: { label: 'Checked In', color: 'success', icon: '✓' },
      checkedOut: { label: 'Checked Out', color: 'info', icon: '✓' },
      overtime: { label: 'Overtime', color: 'warning', icon: '⏰' },

      // Default fallback
      default: { label: status, color: 'neutral', icon: '' }
    }

    return configs[status] || configs.default
  }

  const config = getStatusConfig(status, variant)

  return (
    <span className={`status-badge status-${config.color} status-${size} ${className}`}>
      {config.icon && <span className="status-icon">{config.icon}</span>}
      <span className="status-text">{config.label}</span>
    </span>
  )
}

// QuickStatus Component for simple status indicators
export function QuickStatus({ status, showIcon = true, showText = true }) {
  const getQuickConfig = (status) => {
    const configs = {
      present: { icon: '🟢', text: 'Present' },
      absent: { icon: '🔴', text: 'Absent' },
      late: { icon: '🟡', text: 'Late' },
      pending: { icon: '🟡', text: 'Pending' },
      approved: { icon: '🟢', text: 'Approved' },
      rejected: { icon: '🔴', text: 'Rejected' },
      active: { icon: '🟢', text: 'Active' },
      inactive: { icon: '⚪', text: 'Inactive' }
    }
    return configs[status] || { icon: '⚪', text: status }
  }

  const config = getQuickConfig(status)

  return (
    <span className="quick-status">
      {showIcon && <span className="quick-icon">{config.icon}</span>}
      {showText && <span className="quick-text">{config.text}</span>}
    </span>
  )
}
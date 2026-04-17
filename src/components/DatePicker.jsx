import { useState, useRef, useEffect } from 'react'
import { formatDateKey } from '../lib/time'

// DatePicker Component
export function DatePicker({ value, onChange, placeholder = 'Select date', className = '', disabled = false }) {
  const [isOpen, setIsOpen] = useState(false)
  const [currentMonth, setCurrentMonth] = useState(() => value ? new Date(`${value}T12:00:00.000Z`) : new Date())
  const inputRef = useRef(null)
  const calendarRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (calendarRef.current && !calendarRef.current.contains(event.target) &&
          inputRef.current && !inputRef.current.contains(event.target)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const formatDisplayDate = (dateKey) => {
    if (!dateKey) return ''
    const date = new Date(`${dateKey}T12:00:00.000Z`)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const getDaysInMonth = (date) => {
    const year = date.getFullYear()
    const month = date.getMonth()
    const firstDay = new Date(year, month, 1)
    const lastDay = new Date(year, month + 1, 0)
    const daysInMonth = lastDay.getDate()
    const startingDayOfWeek = firstDay.getDay()

    const days = []

    // Add empty cells for days before the first day of the month
    for (let i = 0; i < startingDayOfWeek; i++) {
      days.push(null)
    }

    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(day)
    }

    return days
  }

  const handleDateSelect = (day) => {
    if (!day) return

    const selectedDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
    const dateKey = formatDateKey(selectedDate)
    onChange(dateKey)
    setIsOpen(false)
  }

  const navigateMonth = (direction) => {
    setCurrentMonth(prev => {
      const newDate = new Date(prev)
      newDate.setMonth(prev.getMonth() + direction)
      return newDate
    })
  }

  const isSelectedDate = (day) => {
    if (!value || !day) return false
    const currentDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
    const currentDateKey = formatDateKey(currentDate)
    return currentDateKey === value
  }

  const isToday = (day) => {
    if (!day) return false
    const today = new Date()
    const currentDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), day)
    return currentDate.toDateString() === today.toDateString()
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ]

  return (
    <div className={`date-picker ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={formatDisplayDate(value)}
        placeholder={placeholder}
        readOnly
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className="date-picker-input"
        disabled={disabled}
      />

      {isOpen && !disabled && (
        <div ref={calendarRef} className="date-picker-calendar">
          <div className="date-picker-header">
            <button
              type="button"
              className="date-picker-nav"
              onClick={() => navigateMonth(-1)}
              aria-label="Previous month"
            >
              ‹
            </button>
            <div className="date-picker-title">
              {monthNames[currentMonth.getMonth()]} {currentMonth.getFullYear()}
            </div>
            <button
              type="button"
              className="date-picker-nav"
              onClick={() => navigateMonth(1)}
              aria-label="Next month"
            >
              ›
            </button>
          </div>

          <div className="date-picker-weekdays">
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(day => (
              <div key={day} className="date-picker-weekday">
                {day}
              </div>
            ))}
          </div>

          <div className="date-picker-days">
            {getDaysInMonth(currentMonth).map((day, index) => (
              <button
                key={index}
                type="button"
                className={`date-picker-day ${
                  isSelectedDate(day) ? 'selected' : ''
                } ${
                  isToday(day) ? 'today' : ''
                } ${
                  !day ? 'empty' : ''
                }`}
                onClick={() => handleDateSelect(day)}
                disabled={!day}
              >
                {day}
              </button>
            ))}
          </div>

          <div className="date-picker-footer">
            <button
              type="button"
              className="date-picker-today"
              onClick={() => handleDateSelect(new Date().getDate())}
            >
              Today
            </button>
            <button
              type="button"
              className="date-picker-clear"
              onClick={() => {
                onChange('')
                setIsOpen(false)
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
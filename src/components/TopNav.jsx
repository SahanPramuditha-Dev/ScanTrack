import { useEffect, useState } from 'react'
import { isAdminUser } from '../services/attendanceService'

const THEME_KEY = 'scantrack_theme'

export function TopNav({ pathname, user, onSignOut }) {
  const [theme, setTheme] = useState(localStorage.getItem(THEME_KEY) || 'light')
  const path = pathname === '/' ? '/employee' : pathname
  const admin = isAdminUser(user)

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark')
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  const links = user
    ? admin
      ? [
          { href: '/tv', label: 'TV Display' },
          { href: '/employee', label: 'Employee' },
          { href: '/admin', label: 'Admin' },
        ]
      : [{ href: '/employee', label: 'Employee' }]
    : pathname === '/tv'
      ? [{ href: '/tv', label: 'TV Display' }, { href: '/login', label: 'Login' }]
      : [{ href: '/login', label: 'Login' }]

  return (
    <header className="top-nav">
      <div className="brand">WYBE <em>SCANTRACK</em></div>
      <nav className="tabs">
        {links.map((link) => (
          <a key={link.href} href={link.href} className={`tab ${path === link.href ? 'active' : ''}`}>
            {link.label}
          </a>
        ))}
      </nav>
      <div className="row gap">
        {user && (
          <button className="theme-toggle" type="button" onClick={onSignOut}>
            Logout
          </button>
        )}
        <button
          className="theme-toggle"
          type="button"
          onClick={() => setTheme((old) => (old === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
  )
}

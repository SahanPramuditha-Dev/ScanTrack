import './App.css'
import { useEffect, useMemo, useState } from 'react'
import { TopNav } from './components/TopNav'
import { AdminPage } from './pages/AdminPage'
import { EmployeePage } from './pages/EmployeePage'
import { LoginPage } from './pages/LoginPage'
import { TvPage } from './pages/TvPage'
import { isAdminUser, signOut, subscribeAuth } from './services/attendanceService'

function RouteNotFound() {
  return (
    <main className="layout narrow">
      <section className="card">
        <p className="eyebrow">ScanTrack</p>
        <h1>Page not found</h1>
        <p>Use one of these paths:</p>
        <ul>
          <li><code>/employee?t=token</code></li>
          <li><code>/admin</code></li>
          <li><code>/tv</code></li>
        </ul>
      </section>
    </main>
  )
}

function App() {
  const [pathname, setPathname] = useState(window.location.pathname.toLowerCase())
  const [user, setUser] = useState(undefined)
  const isAdmin = useMemo(() => isAdminUser(user), [user])

  useEffect(() => subscribeAuth(setUser), [])

  useEffect(() => {
    const handle = () => setPathname(window.location.pathname.toLowerCase())
    window.addEventListener('popstate', handle)
    return () => window.removeEventListener('popstate', handle)
  }, [])

  const navigate = (to, replace = true) => {
    const current = window.location.pathname.toLowerCase()
    if (current === to) return
    if (replace) {
      window.history.replaceState({}, '', to)
    } else {
      window.history.pushState({}, '', to)
    }
    setPathname(to)
  }

  const logout = async () => {
    await signOut()
    navigate('/login')
  }

  if (user === undefined) {
    return (
      <>
        <TopNav pathname={pathname} user={null} onSignOut={logout} />
        <div className="page-shell">
          <main className="layout narrow">
            <section className="card">
              <p>Loading session...</p>
            </section>
          </main>
        </div>
      </>
    )
  }

  if (!user && pathname !== '/login' && pathname !== '/tv') {
    navigate('/login')
    return null
  }

  if (user && pathname === '/login') {
    navigate(isAdmin ? '/admin' : '/employee')
    return null
  }

  if (user && pathname === '/admin' && !isAdmin) {
    navigate('/employee')
    return null
  }

  let content = <RouteNotFound />
  if (pathname === '/login') {
    content = <LoginPage />
  }

  if (pathname === '/' || pathname === '/employee') {
    content = <EmployeePage />
  }

  if (pathname === '/admin') {
    content = <AdminPage user={user} />
  }

  if (pathname === '/tv') {
    content = <TvPage />
  }

  return (
    <>
      <TopNav pathname={pathname} user={user} onSignOut={logout} />
      <div className="page-shell">{content}</div>
    </>
  )
}

export default App

import { useState } from 'react'
import { APP_CONFIG } from '../config'
import { consumeAuthError, demoSignIn, isProductionMode, signInWithGoogle } from '../services/attendanceService'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(consumeAuthError())

  const loginGoogle = async () => {
    setLoading(true)
    setError('')
    try {
      await signInWithGoogle()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const loginDemo = async (event) => {
    event.preventDefault()
    if (!email.trim()) {
      setError('Enter your work email.')
      return
    }

    setLoading(true)
    setError('')
    try {
      await demoSignIn(email)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-stage">
      <div className="login-glow" aria-hidden="true" />
      <section className="card login-card">
        <p className="eyebrow">{APP_CONFIG.companyName}</p>
        <h1>Welcome Back</h1>
        <p className="muted login-sub">Centralized sign-in for employee and admin access.</p>

        {isProductionMode() ? (
          <button onClick={loginGoogle} disabled={loading} className="login-main-btn">
            Continue with Google
          </button>
        ) : (
          <form className="stack" onSubmit={loginDemo}>
            <label>
              Work Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@wybefashion.com"
              />
            </label>
            <button type="submit" disabled={loading} className="login-main-btn">
              Sign in
            </button>
          </form>
        )}

        {error && <p className="error-text">{error}</p>}

        <div className="login-footnote">
          <span>Role-based access is automatic after login.</span>
        </div>
      </section>
    </main>
  )
}

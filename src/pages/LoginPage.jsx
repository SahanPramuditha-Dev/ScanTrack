import { useState } from 'react'
import { APP_CONFIG } from '../config'
import { useToast } from '../components/useToast'
import { FloatingInput } from '../components/FormField'
import { LoadingSpinner } from '../components/Loading'
import { consumeAuthError, demoSignIn, isProductionMode, signInWithGoogle } from '../services/attendanceService'

export function LoginPage() {
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(consumeAuthError())

  const loginGoogle = async () => {
    setLoading(true)
    setError('')
    try {
      await signInWithGoogle()
    } catch (err) {
      toast.addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  const loginDemo = async (event) => {
    event.preventDefault()
    if (!email.trim()) {
      toast.addToast('Enter your work email.', 'warning')
      return
    }

    setLoading(true)
    setError('')
    try {
      await demoSignIn(email)
    } catch (err) {
      toast.addToast(err.message, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-stage">
      <div className="login-glow" aria-hidden="true" />
      <section className="card login-card" data-anim="3">
        <svg className="login-hero" viewBox="0 0 100 100" aria-hidden="true" data-anim="0">
          <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0.2" strokeDasharray="0 251">
            <animate attributeName="strokeDasharray" values="0 251 251 251;126 251 125 251;251 251 0 251" dur="2s" repeatCount="indefinite"/>
            <animate attributeName="strokeDashoffset" values="0;-63;-126" dur="2s" repeatCount="indefinite"/>
          </circle>
          <path d="M30 50 L50 30 L70 50 L50 70 Z" fill="currentColor" opacity="0.3">
            <animateTransform attributeName="transform" type="rotate" from="0 50 50" to="360 50 50" dur="20s" repeatCount="indefinite"/>
          </path>
        </svg>
        <p className="eyebrow" data-anim="1">{APP_CONFIG.companyName}</p>
        <h1 data-anim="2">Welcome Back</h1>
        <p className="muted login-sub" data-anim="3">Centralized sign-in for employee and admin access.</p>

        {isProductionMode() ? (
          <button onClick={loginGoogle} disabled={loading} className="login-main-btn row gap" data-anim="4">
            {loading ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Signing in...
              </>
            ) : (
              <>
                <svg className="google-icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.83l2.66-2.07z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </>
            )}
          </button>
        ) : (
          <form className="stack" onSubmit={loginDemo} data-anim="4">
            <FloatingInput
              label="Work Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <button type="submit" disabled={loading} className="login-main-btn">
              {loading ? (
                <>
                  <LoadingSpinner size="small" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        )}

        {error && (
          <div className="login-error">
            <p className="error-text">{error}</p>
          </div>
        )}

        {error && <p className="error-text" data-anim="5">{error}</p>}

        <div className="login-footnote" data-anim="6">
          <span>Role-based access is automatic after login.</span>
        </div>
      </section>
    </main>
  )
}


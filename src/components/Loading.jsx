export function LoadingSpinner({ size = 'medium', className = '' }) {
  return (
    <div className={`spinner spinner-${size} ${className}`} aria-hidden="true">
      <div className="spinner-inner"></div>
    </div>
  )
}

export function LoadingSkeleton({ className = '', style = {} }) {
  return (
    <div
      className={`skeleton ${className}`}
      style={style}
      aria-hidden="true"
    />
  )
}
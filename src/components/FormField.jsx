import { useId } from 'react'

export function FormField({
  label,
  error,
  required,
  children,
  className = '',
  ...props
}) {
  const fieldId = useId()
  const actualId = props.id || fieldId

  return (
    <div className={`form-field ${error ? 'form-field-error' : ''} ${className}`}>
      {label && (
        <label htmlFor={actualId} className="form-label">
          {label}
          {required && <span className="form-required">*</span>}
        </label>
      )}
      <div className="form-input-wrapper">
        {children}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}

export function FloatingInput({
  label,
  error,
  required,
  className = '',
  ...inputProps
}) {
  const inputId = useId()
  const actualId = inputProps.id || inputId
  const hasValue = inputProps.value && inputProps.value.toString().trim() !== ''

  return (
    <FormField label={label} error={error} required={required} className={className}>
      <div className="floating-input">
        <input
          {...inputProps}
          id={actualId}
          className={`floating-input-field ${hasValue ? 'has-value' : ''}`}
          placeholder=" "
        />
        <label htmlFor={actualId} className="floating-label">
          {label}
          {required && <span className="form-required">*</span>}
        </label>
      </div>
    </FormField>
  )
}
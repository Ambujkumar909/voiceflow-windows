import { useEffect, useId, useRef, type ReactNode } from 'react'

export const api = window.api.settings

/** The VoiceFlow mark (same drawing as build/icon.svg, simplified for small sizes). */
export function Logo({ size = 28 }: { size?: number }) {
  const id = useId()
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b6cff" />
          <stop offset="0.55" stopColor="#5b3df5" />
          <stop offset="1" stopColor="#3a1fc4" />
        </linearGradient>
      </defs>
      <rect x="32" y="32" width="960" height="960" rx="232" fill={`url(#${id})`} />
      <path d="M318 322 L512 706" stroke="#fff" strokeWidth="128" strokeLinecap="round" />
      <circle cx="590" cy="550" r="58" fill="#fff" />
      <circle cx="656" cy="418" r="48" fill="#fff" opacity="0.78" />
      <circle cx="710" cy="306" r="38" fill="#fff" opacity="0.55" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <span className="brand-name">
      Voice<b>Flow</b>
    </span>
  )
}

/** Hold keys / accelerator → keycap chips, e.g. "Ctrl+Win" → [Ctrl] + [Win]. */
export function Keys({ combo, small }: { combo: string; small?: boolean }) {
  const parts = combo.split('+').map((k) => ({ Control: 'Ctrl', Super: 'Win', CommandOrControl: 'Ctrl' })[k] ?? k)
  return (
    <span className={`keys ${small ? 'sm' : ''}`}>
      {parts.map((k, i) => (
        <span key={i} className="keys">
          <span className="key">{k}</span>
          {i < parts.length - 1 && '+'}
        </span>
      ))}
    </span>
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className={`switch ${on ? 'on' : ''}`}>
      <input type="checkbox" role="switch" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

/** Centered dialog; Esc or a click on the backdrop closes it. */
export function Modal({ onClose, children, className = 'dialog', label }: { onClose: () => void; children: ReactNode; className?: string; label: string }) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close.current()
      }
    }
    window.addEventListener('keydown', k, true)
    // Focus the dialog itself (keyboard users can Tab in); fields that want focus use autoFocus.
    if (!box.current?.contains(document.activeElement)) box.current?.focus()
    return () => window.removeEventListener('keydown', k, true)
  }, [])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ outline: 'none' }}>
        {children}
      </div>
    </div>
  )
}

export type Toast = { kind: 'ok' | 'err'; text: string } | null
export function ToastView({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDone, toast.kind === 'err' ? 5000 : 1800)
    return () => clearTimeout(t)
  }, [toast, onDone])
  return toast ? (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.text}
    </div>
  ) : null
}

/** Settings row: label + description on the left, control in a fixed slot on the right. */
export function Item({ label, desc, children, wide }: { label: ReactNode; desc?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="s-item">
      <div className="s-text">
        <div className="s-label">{label}</div>
        {desc && <div className="s-desc">{desc}</div>}
      </div>
      <div className={`s-control ${wide ? 'wide' : ''}`}>{children}</div>
    </div>
  )
}

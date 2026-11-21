/** LIM 的潮汐视觉标记：两组错位的正弦波。 */
export function WaveMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="LIM">
      <rect width="32" height="32" rx="9" fill="var(--tide)" />
      <path d="M5 15c2.8-4 5.6-4 8.4 0s5.6 4 8.4 0 3.6-3 5.2 0" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <path d="M5 22c2.8-4 5.6-4 8.4 0s5.6 4 8.4 0 3.6-3 5.2 0" stroke="var(--coral)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** 细波浪线，用作分隔与装饰。 */
export function WaveLine({ className, color = "currentColor" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 120 8" preserveAspectRatio="none" className={className} aria-hidden="true">
      <path
        d="M0 4c5-4 10-4 15 0s10 4 15 0 10-4 15 0 10 4 15 0 10-4 15 0 10 4 15 0 10-4 15 0 10 4 15 0"
        stroke={color}
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  )
}

/** 三层叠浪，用于空状态与侧栏底部。 */
export function WaveStack({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 120" preserveAspectRatio="none" className={className} aria-hidden="true">
      <path d="M0 60 C 60 20, 120 20, 180 60 S 300 100, 400 60 V120 H0 Z" fill="var(--tide)" opacity=".18" />
      <path d="M0 80 C 70 45, 130 45, 200 80 S 330 115, 400 80 V120 H0 Z" fill="var(--tide)" opacity=".28" />
      <path d="M0 100 C 80 70, 140 70, 220 100 S 340 130, 400 100 V120 H0 Z" fill="var(--tide)" opacity=".5" />
    </svg>
  )
}

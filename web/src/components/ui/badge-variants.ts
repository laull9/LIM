import { cva } from 'class-variance-authority'

export const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold leading-4 transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        coral: 'bg-coral text-white',
        outline: 'border border-border text-foreground',
        muted: 'bg-muted text-muted-foreground',
        sand: 'bg-sand text-deep',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

interface BannerProps {
  text: string
}

export function Banner({ text }: BannerProps) {
  return (
    <div className="mb-1.5 flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-ui text-muted-foreground">
      <span className="animate-live size-1 rounded-full bg-current" />
      {text}
    </div>
  )
}

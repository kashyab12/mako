import { cn } from "@/lib/utils"

/**
 * The Mako fin.
 *
 * Inline rather than an <img>: the mark appears at 13px in the title bar where
 * a raster would soften, it must follow the theme's foreground in both
 * schemes, and a single path costs less than a request.
 *
 * The silhouette is a swept dorsal fin — a near-vertical trailing edge with
 * the leading edge raked back into a concave sweep.
 */
export function MakoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path d="M7.4 3.1c.2-.14.47-.05.55.18 1.05 3.1 3.3 6.36 6.9 9.9 1.2 1.18 2.4 2.24 3.62 3.2.28.22.42.35.42.53 0 .2-.16.35-.4.35H5.3c-.26 0-.42-.16-.4-.4.24-3.06.63-5.6 1.2-7.7.5-1.9 1.1-3.5 1.8-4.8.05-.1.1-.18.16-.24l-.66-.1Z" />
      <path d="M7.4 3.1C6.1 5.2 5.2 7.7 4.7 10.6c-.5 2.9-.6 5.4-.5 7.5 0 .2.16.35.36.35h1.1c-.2-3.6.13-6.9 1-9.9.4-1.5.9-3 1.5-4.4.1-.3.02-.6-.24-.75a.53.53 0 0 0-.52-.3Z" />
    </svg>
  )
}

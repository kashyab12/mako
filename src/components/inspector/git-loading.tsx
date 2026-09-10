import { Skeleton } from "@/components/ui/skeleton"

export function GitLoading({
  label,
  kind = "changes",
}: {
  label: string
  kind?: "changes" | "history" | "diff"
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="git-loading min-w-0 px-3 py-4"
    >
      <p className="mb-4 text-label text-faint">{label}</p>
      <div aria-hidden className="flex flex-col gap-4">
        {["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-3/4", "w-1/2"].map(
          (width, index) => (
            <div key={width} className="relative flex gap-3">
              {kind === "history" ? (
                <div className="relative flex w-3 shrink-0 justify-center">
                  {index < 5 ? (
                    <span className="absolute top-2 -bottom-4 w-px bg-hairline" />
                  ) : null}
                  <Skeleton className="relative mt-1 size-2 rounded-full" />
                </div>
              ) : (
                <Skeleton className="size-3.5 shrink-0" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className={`h-2.5 ${width}`} />
                {kind === "history" ? (
                  <div className="flex gap-2">
                    <Skeleton className="h-2 w-12" />
                    <Skeleton className="h-2 w-20" />
                  </div>
                ) : null}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}

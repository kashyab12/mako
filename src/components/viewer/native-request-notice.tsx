import { threads, useThreads } from "@/state/threads"

export function NativeRequestNotice({ path }: { path: string }) {
  const requests = useThreads((state) => state.nativeRequests)
  const retained = requests.filter(
    (request) =>
      request.input.path === path &&
      (request.status === "failed" || request.status === "uncertain")
  )
  if (!retained.length) return null
  return (
    <div className="shrink-0 border-b border-hairline px-3.5 py-2 text-label text-muted-foreground">
      {retained.slice(-10).map((request) => (
        <details key={request.input.id}>
          <summary className="pressable cursor-pointer">
            {request.status === "uncertain"
              ? "Unconfirmed native request"
              : "Failed native request"}{" "}
            · saved with {request.input.attachments.length} attachments
          </summary>
          <p className="mt-2">{request.error}</p>
          <p className="contain-turn mt-2 whitespace-pre-wrap">
            {request.input.text}
          </p>
          <div className="my-2 flex gap-3">
            <button
              type="button"
              className="pressable underline"
              onClick={() => void threads.retryNative(request)}
            >
              Send as a new request
            </button>
            <button
              type="button"
              className="pressable underline"
              onClick={() => void threads.dismissNative(request.input.id)}
            >
              Dismiss
            </button>
          </div>
        </details>
      ))}
    </div>
  )
}

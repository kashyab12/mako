import { makoMcpHandler } from "../../../src/mcp/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export const runtime = "nodejs"

async function handle(request: Request): Promise<Response> {
  const response = await makoMcpHandler(request)
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")
  headers.set("X-Content-Type-Options", "nosniff")
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export { handle as DELETE, handle as GET, handle as POST }

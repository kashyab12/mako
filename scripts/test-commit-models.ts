import assert from "node:assert/strict"
import { APICallError } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { completeUtilityText, utilityLanguageModel, UtilityModelError } from "../electron/utility-models.ts"

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }
const signal = AbortSignal.timeout(30_000)
const success = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: "fix: describe the change" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }) })
assert.equal(await completeUtilityText(success, "Instructions", "sample.ts changed", signal), "fix: describe the change")
assert.equal(success.doGenerateCalls.length, 1)

for (const [status, message, kind] of [[401, "invalid key", "auth"], [403, "permission denied", "auth"], [404, "unknown model", "request"], [400, "context length exceeded", "context"], [413, "payload too large", "context"]] as const) {
  const denied = new MockLanguageModelV4({ doGenerate: async () => { throw new APICallError({ message, url: "https://example.invalid", requestBodyValues: {}, responseBody: "PRIVATE_PROVIDER_BODY", statusCode: status, isRetryable: false }) } })
  await assert.rejects(completeUtilityText(denied, "instructions", "prompt", signal), (error: Error) => error instanceof UtilityModelError && error.kind === kind && !error.message.includes("PRIVATE_PROVIDER_BODY"))
  assert.equal(denied.doGenerateCalls.length, 1)
}
for (const text of ["", "partial"]) {
  const invalid = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: text ? "length" : "stop", raw: text ? "length" : "stop" }, usage, warnings: [] }) })
  await assert.rejects(completeUtilityText(invalid, "instructions", "prompt", signal), (error: Error) => error instanceof UtilityModelError && error.kind === "output")
}
const timeout = new AbortController()
const timer = setTimeout(() => timeout.abort(new DOMException("Timed out", "TimeoutError")), 10)
const waiting = new MockLanguageModelV4({ doGenerate: (options) => new Promise((_resolve, reject) => { options.abortSignal?.throwIfAborted(); options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true }) }) })
await assert.rejects(completeUtilityText(waiting, "instructions", "prompt", timeout.signal), /timed out/)
clearTimeout(timer)

const transports = [
  { provider: "google", model: "gemini-3.8-flash", path: ":generateContent", header: "x-goog-api-key", response: JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "fix: verify Google transport" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } }) },
  { provider: "anthropic", model: "claude-fable-5-1", path: "/messages", header: "x-api-key", response: JSON.stringify({ id: "test", type: "message", role: "assistant", model: "claude-fable-5-1", content: [{ type: "text", text: "fix: verify Anthropic transport" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }) },
  { provider: "openai", model: "gpt-6-astra", path: "/responses", header: "authorization", response: JSON.stringify({ id: "test", object: "response", created_at: 1, model: "gpt-6-astra", status: "completed", output: [{ id: "msg-test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fix: verify OpenAI transport", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }) },
] as const
for (const transport of transports) {
  let called = 0
  const request: typeof fetch = async (input, init) => {
    called += 1
    assert.ok(String(input).endsWith(transport.path))
    assert.ok(new Headers(init?.headers).get(transport.header)?.includes("synthetic-transport-key"))
    assert.ok(String(init?.body).includes("sample.ts"))
    if (transport.provider === "openai") assert.ok(String(init?.body).includes('"store":false'))
    return new Response(transport.response, { headers: { "Content-Type": "application/json" } })
  }
  const direct = utilityLanguageModel({ provider: transport.provider, model: transport.model, contextTokens: 128_000 }, "synthetic-transport-key", request)
  assert.match(await completeUtilityText(direct, "instructions", "sample.ts changed", signal), /^fix: verify/)
  assert.equal(called, 1)
}

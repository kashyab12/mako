import assert from "node:assert/strict"
import { APICallError } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import {
  chunkCommitText,
  generateCommitDraft,
} from "../electron/commit-generation.ts"
import {
  completeUtilityText,
  parseConnection,
  utilityLanguageModel,
} from "../electron/utility-models.ts"

const response = {
  content: [{ type: "text", text: "fix: preserve commit drafts" }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 },
  },
  warnings: [],
} satisfies Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>
const signal = AbortSignal.timeout(20_000)
const patch = {
  text: "File: sample.ts\n+const value = 1",
  scope: "staged",
  files: 1,
  warnings: [],
} satisfies Parameters<typeof generateCommitDraft>[0]["patch"]
const model = new MockLanguageModelV4({ doGenerate: response })
const result = await generateCommitDraft({
  model,
  patch,
  signal,
  contextTokens: 32_000,
})
assert.equal(result.message, "fix: preserve commit drafts")
assert.equal(result.requests, 1)
assert.equal(model.doGenerateCalls.length, 1)

let running = 0
let peak = 0
const concurrent = new MockLanguageModelV4({
  doGenerate: async () => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 5))
    running -= 1
    return response
  },
})
const large = await generateCommitDraft({
  model: concurrent,
  patch: {
    ...patch,
    text: "File: big.ts\n" + "+new behavior\n".repeat(10_000),
  },
  contextTokens: 32_000,
  signal,
})
assert.ok(large.requests > 2)
assert.equal(peak, 3)
assert.equal(running, 0)

const oversized = new MockLanguageModelV4({
  doGenerate: async (options) => {
    if (JSON.stringify(options.prompt).length > 12_000)
      throw new APICallError({
        message: "input token count exceeds maximum tokens",
        url: "https://example.test",
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      })
    return response
  },
})
const recovered = await generateCommitDraft({
  model: oversized,
  patch: { ...patch, text: "File: input.ts\n" + "a".repeat(20_000) },
  contextTokens: 32_000,
  signal,
})
assert.ok(recovered.requests > 2)
assert.equal(recovered.message, response.content[0].text)

const denied = new MockLanguageModelV4({
  doGenerate: async () => {
    throw new APICallError({
      message: "bad test-key-never-return",
      responseBody: "test-key-never-return",
      url: "https://example.test",
      requestBodyValues: {},
      statusCode: 401,
      isRetryable: false,
    })
  },
})
await assert.rejects(
  completeUtilityText(denied, "instructions", "prompt", signal),
  (error: Error) => {
    assert.match(error.message, /rejected this API key/)
    assert.doesNotMatch(error.message, /test-key-never-return/)
    return true
  }
)
assert.equal(denied.doGenerateCalls.length, 1)
await assert.rejects(
  completeUtilityText(
    new MockLanguageModelV4({ doGenerate: { ...response, content: [] } }),
    "instructions",
    "prompt",
    signal
  ),
  /no text/
)
await assert.rejects(
  completeUtilityText(
    new MockLanguageModelV4({
      doGenerate: {
        ...response,
        finishReason: { unified: "length", raw: "length" },
      },
    }),
    "instructions",
    "prompt",
    signal
  ),
  /output limit/
)
await assert.rejects(
  generateCommitDraft({
    model,
    patch,
    contextTokens: 32_000,
    signal: AbortSignal.abort(),
  }),
  /abort/i
)
const unicode = chunkCommitText(
  "File: 日本.ts\n" + "日本語".repeat(3_000),
  1_024
)
assert.ok(
  unicode.every(
    (chunk) =>
      Buffer.byteLength(chunk) <= 1_024 &&
      !chunk.includes("\ufffd") &&
      chunk.startsWith("File: 日本.ts")
  )
)
assert.throws(
  () =>
    parseConnection({
      provider: "openai-compatible",
      model: "test",
      baseUrl: "https://user:password@example.test/v1",
      contextTokens: 32_000,
    }),
  /cannot contain credentials/
)
assert.throws(
  () =>
    parseConnection({
      provider: "openai-compatible",
      model: "test",
      baseUrl: "http://example.test/v1",
      contextTokens: 32_000,
    }),
  /HTTPS/
)
assert.equal(
  parseConnection({
    provider: "openai-compatible",
    model: "test",
    baseUrl: "http://localhost:8080/v1/",
    contextTokens: 32_000,
  }).baseUrl,
  "http://localhost:8080/v1"
)
const limited = new MockLanguageModelV4({ doGenerate: response })
await assert.rejects(
  generateCommitDraft({
    model: limited,
    patch: { ...patch, text: "x".repeat(500_000) },
    contextTokens: 8_192,
    signal,
  }),
  /too many model requests/
)
assert.ok(limited.doGenerateCalls.length <= 80)
const timeout = new AbortController()
const timer = setTimeout(
  () => timeout.abort(new DOMException("Timed out", "TimeoutError")),
  10
)
const waiting = new MockLanguageModelV4({
  doGenerate: (options) =>
    new Promise((_resolve, reject) => {
      options.abortSignal?.throwIfAborted()
      options.abortSignal?.addEventListener(
        "abort",
        () => reject(options.abortSignal?.reason),
        { once: true }
      )
    }),
})
await assert.rejects(
  completeUtilityText(waiting, "instructions", "prompt", timeout.signal),
  /timed out/
)
clearTimeout(timer)

const transports = [
  {
    provider: "google",
    model: "gemini-3.8-flash",
    path: ":generateContent",
    header: "x-goog-api-key",
    response: JSON.stringify({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "fix: verify Google transport" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 10,
        totalTokenCount: 20,
      },
    }),
  },
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    path: "/messages",
    header: "x-api-key",
    response: JSON.stringify({
      id: "test",
      type: "message",
      role: "assistant",
      model: "claude-fable-5-1",
      content: [{ type: "text", text: "fix: verify Anthropic transport" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  },
  {
    provider: "openai",
    model: "gpt-6-astra",
    path: "/responses",
    header: "authorization",
    response: JSON.stringify({
      id: "test",
      object: "response",
      created_at: 1,
      model: "gpt-6-astra",
      status: "completed",
      output: [
        {
          id: "msg-test",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "fix: verify OpenAI transport",
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    }),
  },
] as const
for (const transport of transports) {
  let called = 0
  const request: typeof fetch = async (input, init) => {
    called += 1
    assert.ok(String(input).endsWith(transport.path))
    assert.ok(
      new Headers(init?.headers)
        .get(transport.header)
        ?.includes("synthetic-transport-key")
    )
    assert.ok(String(init?.body).includes("sample.ts"))
    if (transport.provider === "openai")
      assert.ok(String(init?.body).includes('"store":false'))
    return new Response(transport.response, {
      headers: { "Content-Type": "application/json" },
    })
  }
  const direct = utilityLanguageModel(
    {
      provider: transport.provider,
      model: transport.model,
      contextTokens: 128_000,
    },
    "synthetic-transport-key",
    request
  )
  const generated = await generateCommitDraft({
    model: direct,
    patch,
    signal,
    contextTokens: 128_000,
  })
  assert.match(generated.message, /^fix: verify/)
  assert.equal(called, 1)
}
console.log(
  "Commit models: Google/OpenAI/Anthropic SDK transports, bounded parallel summaries, context recovery, Unicode budgets, output failures, cancellation, secret-safe errors passed"
)

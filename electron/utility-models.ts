import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { APICallError, generateText, RetryError, type LanguageModel } from "ai"
import { z } from "zod"
import type { UtilityConnectionInput, UtilityProviderInfo } from "./shared.js"

export const utilityProviders: UtilityProviderInfo[] = [
  {
    id: "google",
    name: "Google",
    description: "Gemini with a Google AI Studio API key",
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "GPT models with an OpenAI API key",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Claude with an Anthropic API key",
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible",
    description: "OpenRouter, local models, or your own endpoint",
  },
]

export const utilityProviderSchema = z.enum([
  "google",
  "openai",
  "anthropic",
  "openai-compatible",
])

export const connectionSchema = z.object({
  provider: utilityProviderSchema,
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/),
  baseUrl: z.string().max(2_048).optional(),
  contextTokens: z.number().int().min(8_192).max(2_000_000),
})

export function parseConnection(input: UtilityConnectionInput) {
  const parsed = connectionSchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      "Choose a model ID and a context limit between 8,192 and 2,000,000 tokens."
    )
  return { ...parsed.data, baseUrl: parseUtilityEndpoint(parsed.data) }
}

export function parseUtilityEndpoint(
  connection: Pick<UtilityConnectionInput, "provider" | "baseUrl">
): string | undefined {
  if (connection.provider !== "openai-compatible") {
    if (connection.baseUrl)
      throw new Error(
        "Custom endpoints require an OpenAI-compatible connection."
      )
    return undefined
  }
  let url: URL
  try {
    url = new URL(connection.baseUrl ?? "")
  } catch {
    throw new Error(
      "Enter the endpoint's full base URL, including /v1 if required."
    )
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use HTTPS, or HTTP on localhost. The endpoint URL cannot contain credentials, a query, or a fragment."
    )
  return url.href.replace(/\/$/, "")
}

const privateFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error" })

export function utilityLanguageModel(
  connection: UtilityConnectionInput,
  apiKey: string,
  request: typeof fetch = privateFetch
): LanguageModel {
  const options = { apiKey, fetch: request }
  switch (connection.provider) {
    case "google":
      return createGoogleGenerativeAI(options)(connection.model)
    case "openai":
      return createOpenAI(options)(connection.model)
    case "anthropic":
      return createAnthropic(options)(connection.model)
    case "openai-compatible":
      return createOpenAICompatible({
        ...options,
        name: "custom",
        baseURL: connection.baseUrl!,
      })(connection.model)
  }
}

type UtilityErrorKind =
  "context" | "auth" | "rate-limit" | "timeout" | "output" | "request"

export class UtilityModelError extends Error {
  readonly kind: UtilityErrorKind

  constructor(kind: UtilityErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = "UtilityModelError"
  }
}

export async function completeUtilityText(
  model: LanguageModel,
  instructions: string,
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens = 2_048
): Promise<string> {
  try {
    const result = await generateText({
      model,
      instructions,
      prompt,
      maxOutputTokens,
      reasoning: "low",
      maxRetries: 1,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
      providerOptions: { openai: { store: false } },
      include: {
        requestBody: false,
        requestMessages: false,
        responseBody: false,
      },
    })
    if (result.finishReason === "length")
      throw new UtilityModelError(
        "output",
        "The model reached its output limit. Try a non-reasoning model or retry with shorter instructions."
      )
    const text = result.text.trim()
    if (!text)
      throw new UtilityModelError(
        "output",
        "The model returned no text. Check that this is a text-generation model and try again."
      )
    return text
  } catch (caught) {
    if (signal.aborted)
      throw new UtilityModelError(
        "timeout",
        signal.reason instanceof DOMException &&
          signal.reason.name === "TimeoutError"
          ? "Generation timed out. Try again or stage fewer files."
          : "Generation cancelled."
      )
    const error = RetryError.isInstance(caught) ? caught.lastError : caught
    if (error instanceof UtilityModelError) throw error
    if (APICallError.isInstance(error)) {
      const status = error.statusCode
      const message = `${error.message} ${error.responseBody ?? ""}`
      if (
        status === 413 ||
        ((status === 400 || status === 422) &&
          /context.{0,30}(length|window|limit)|token.{0,30}(limit|exceed|maximum)|too (many tokens|large|long)|input.{0,30}(long|exceed)/i.test(
            message
          ))
      )
        throw new UtilityModelError(
          "context",
          "The model's context limit was exceeded."
        )
      if (
        status === 401 ||
        status === 403 ||
        (status === 400 &&
          /api.key.{0,30}(invalid|not valid)|API_KEY_INVALID/i.test(message))
      )
        throw new UtilityModelError(
          "auth",
          "The provider rejected this API key. Check the key and its model access in Commit messages settings."
        )
      if (status === 429)
        throw new UtilityModelError(
          "rate-limit",
          "The provider's rate or quota limit was reached. Check billing or wait before retrying."
        )
      if (status === 404)
        throw new UtilityModelError(
          "request",
          "This model or endpoint was not found. Check the model ID and base URL in Commit messages settings."
        )
      throw new UtilityModelError(
        "request",
        `The provider rejected the request${status ? ` (HTTP ${status})` : ""}. Check the model settings and retry.`
      )
    }
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      throw new UtilityModelError(
        "timeout",
        "The model did not respond in time. Try again or choose a faster model."
      )
    throw new UtilityModelError(
      "request",
      "Could not reach the model. Check your connection and endpoint, then retry."
    )
  }
}

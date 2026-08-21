import assert from "node:assert/strict"
import {
  classifyCodexWindows,
  parseOpenCodeAccounts,
  type UsageWindow,
} from "../electron/accounts"

const fiveHour: UsageWindow = {
  usedPercent: 40,
  windowMinutes: 300,
  resetsAt: 1,
}
const week: UsageWindow = {
  usedPercent: 15,
  windowMinutes: 10_080,
  resetsAt: 2,
}

assert.deepEqual(classifyCodexWindows([week]), {
  session: null,
  weekly: week,
})
assert.deepEqual(classifyCodexWindows([week, fiveHour]), {
  session: fiveHour,
  weekly: week,
})

const jwtHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString(
  "base64url"
)
const jwtPayload = Buffer.from(
  JSON.stringify({
    "https://api.openai.com/profile": { email: "fixture@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
  })
).toString("base64url")
const accessToken = `${jwtHeader}.${jwtPayload}.fixture-signature`
const secrets = {
  accessToken,
  refreshToken: "refresh-secret-fixture",
  apiKey: "api-secret-fixture",
}
const discovered = parseOpenCodeAccounts(
  JSON.stringify({
    openai: {
      type: "oauth",
      access: secrets.accessToken,
      refresh: secrets.refreshToken,
      expires: 9_999_999_999_999,
      accountId: "stored-account-fallback",
    },
    anthropic: { type: "api", key: secrets.apiKey },
  }),
  "/fixture/opencode/auth.json"
)

assert.deepEqual(discovered, [
  {
    harness: "opencode",
    name: "openai",
    providerId: "openai",
    authType: "oauth",
    email: "fixture@example.com",
    accountId: "account-fixture",
    dir: "/fixture/opencode/auth.json",
    active: true,
    source: "opencode",
  },
  {
    harness: "opencode",
    name: "anthropic",
    providerId: "anthropic",
    authType: "api",
    dir: "/fixture/opencode/auth.json",
    active: true,
    source: "opencode",
  },
])
const serialized = JSON.stringify(discovered)
for (const secret of Object.values(secrets)) {
  assert.equal(serialized.includes(secret), false)
}
for (const secretField of ["access", "refresh", "key", "token", "expires"]) {
  assert.equal(serialized.includes(`"${secretField}"`), false)
}
assert.equal(serialized.includes("stored-account-fallback"), false)

console.log("Account discovery and usage classification passed")

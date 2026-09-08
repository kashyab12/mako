import { codeToTokens, bundledLanguages, type BundledLanguage } from "shiki"

const theme = {
  name: "mako",
  tokenColors: [
    {
      settings: {
        foreground: "var(--shiki-foreground)",
        background: "var(--shiki-background)",
      },
    },
    {
      scope: ["comment"],
      settings: { foreground: "var(--shiki-token-comment)" },
    },
    {
      scope: ["string"],
      settings: { foreground: "var(--shiki-token-string)" },
    },
    {
      scope: ["keyword", "storage"],
      settings: { foreground: "var(--shiki-token-keyword)" },
    },
    {
      scope: ["constant"],
      settings: { foreground: "var(--shiki-token-constant)" },
    },
    {
      scope: ["entity.name.function"],
      settings: { foreground: "var(--shiki-token-function)" },
    },
    {
      scope: ["variable.parameter"],
      settings: { foreground: "var(--shiki-token-parameter)" },
    },
    {
      scope: ["punctuation"],
      settings: { foreground: "var(--shiki-token-punctuation)" },
    },
  ],
}

function supportedLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language)
}

export async function highlightCode(source: string, language: string) {
  return (
    await codeToTokens(source, {
      lang: supportedLanguage(language) ? language : "text",
      theme,
    })
  ).tokens
}

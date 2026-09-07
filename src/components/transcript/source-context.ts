import { createContext, useContext } from "react"
export interface TranscriptSource {
  threadPath?: string
  liveId?: string
}
export const TranscriptSourceContext = createContext<TranscriptSource>({})
export const useTranscriptSource = () => useContext(TranscriptSourceContext)

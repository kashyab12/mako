import { ListCard, SettingRow, Toggle } from "@/components/ui/kit"
import { togglePref, usePrefs } from "@/state/prefs"

export function ConversationSection() {
  const showThinking = usePrefs((prefs) => prefs.showThinking)
  const autoDiff = usePrefs((prefs) => prefs.autoOpenDiff)

  return (
    <ListCard>
      <SettingRow
        title="Show reasoning"
        description="Collapsed by default; this hides it entirely"
      >
        <Toggle on={showThinking} onChange={() => togglePref("showThinking")} />
      </SettingRow>
      <SettingRow
        title="Open the diff on select"
        description="Off keeps the changes panel as a plain list"
      >
        <Toggle on={autoDiff} onChange={() => togglePref("autoOpenDiff")} />
      </SettingRow>
    </ListCard>
  )
}

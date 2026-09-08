import { playFeedback } from "@/state/feedback"
import { Action, ListCard, Segmented, SettingRow, Toggle } from "@/components/ui/kit"
import { setPref, usePrefs, type Theme } from "@/state/prefs"

export function AppearanceSection() {
  const theme = usePrefs((prefs) => prefs.theme)

  const enabled = usePrefs((prefs) => prefs.soundEnabled)
  const volume = usePrefs((prefs) => prefs.soundVolume)

  return (
    <ListCard>
      <SettingRow title="Theme" description="Follows the system when set to Auto">
        <Segmented<Theme>
          value={theme}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "Auto" },
          ]}
          onChange={(next) => setPref("theme", next)}
        />
      </SettingRow>
      <SettingRow title="Interface sounds" description="Quiet cues for copying and completed replies">
        <Toggle label="Interface sounds" on={enabled} onChange={() => setPref("soundEnabled", !enabled)} />
      </SettingRow>
      <SettingRow title="Volume" description="Preview the completion sound">
        <input aria-label="Sound volume" type="range" min="0" max="1" step="0.05" value={volume}
          disabled={!enabled} className="w-24 accent-foreground"
          onChange={(event) => setPref("soundVolume", Number(event.target.value))} />
        <Action disabled={!enabled} onClick={() => playFeedback("complete")}>Preview</Action>
      </SettingRow>
    </ListCard>
  )
}

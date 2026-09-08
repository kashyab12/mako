import { playFeedback } from "@/state/feedback"
import {
  Action,
  ListCard,
  Segmented,
  SettingRow,
  Toggle,
} from "@/components/ui/kit"
import { setPref, usePrefs, type Theme, type OceanTone } from "@/state/prefs"

export function AppearanceSection() {
  const theme = usePrefs((prefs) => prefs.theme)
  const oceanTone = usePrefs((prefs) => prefs.oceanTone)
  const oceanMotion = usePrefs((prefs) => prefs.oceanMotion)

  const enabled = usePrefs((prefs) => prefs.soundEnabled)
  const volume = usePrefs((prefs) => prefs.soundVolume)

  return (
    <ListCard>
      <SettingRow
        title="Theme"
        description="Follows the system when set to Auto"
      >
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
      <SettingRow
        title="Ocean color"
        description="Only the opening illustration changes"
      >
        <Segmented<OceanTone>
          value={oceanTone}
          options={[
            { value: "ink", label: "Warm ink" },
            { value: "moon", label: "Silver ink" },
          ]}
          onChange={(next) => setPref("oceanTone", next)}
        />
      </SettingRow>
      <SettingRow
        title="Reflected light"
        description="Pauses while writing and respects reduced motion"
      >
        <Toggle
          label="Reflected light"
          on={oceanMotion}
          onChange={() => setPref("oceanMotion", !oceanMotion)}
        />
      </SettingRow>
      <SettingRow
        title="Interface sounds"
        description="Quiet cues for copying and completed replies"
      >
        <Toggle
          label="Interface sounds"
          on={enabled}
          onChange={() => setPref("soundEnabled", !enabled)}
        />
      </SettingRow>
      <SettingRow title="Volume" description="Preview the completion sound">
        <input
          aria-label="Sound volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          disabled={!enabled}
          className="w-24 accent-foreground"
          onChange={(event) =>
            setPref("soundVolume", Number(event.target.value))
          }
        />
        <Action disabled={!enabled} onClick={() => playFeedback("complete")}>
          Preview
        </Action>
      </SettingRow>
    </ListCard>
  )
}

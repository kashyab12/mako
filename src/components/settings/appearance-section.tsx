import { ListCard, Segmented, SettingRow } from "@/components/ui/kit"
import { setPref, usePrefs, type Theme } from "@/state/prefs"

export function AppearanceSection() {
  const theme = usePrefs((prefs) => prefs.theme)

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
    </ListCard>
  )
}

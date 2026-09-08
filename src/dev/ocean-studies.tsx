import { createRoot } from "react-dom/client"
import { DitherField } from "@/components/ui/dither-field"
import { setPref, usePrefs, type OceanTone } from "@/state/prefs"
import "../index.css"

const treatments: { tone: OceanTone; title: string; description: string }[] = [
  {
    tone: "ink",
    title: "Warm ink",
    description: "The original engraving, with a warm moving wake.",
  },
  {
    tone: "sea",
    title: "Sea glass",
    description: "Muted green water against the warm desk. My recommendation.",
  },
  {
    tone: "moon",
    title: "Moonlight",
    description: "Cool blue-grey ink with a silver wake.",
  },
]

function Studies() {
  const motion = usePrefs((prefs) => prefs.oceanMotion)
  const selected = usePrefs((prefs) => prefs.oceanTone)
  return (
    <div className="h-full overflow-y-auto bg-background p-6 text-ui text-foreground">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-title font-semibold">Moving water</h1>
          <p className="mt-1 text-muted-foreground">
            Actual production artwork and motion. Focus a draft to pause its
            wake.
          </p>
        </div>
        <button
          className="pressable rounded-md bg-fill-selected px-3 py-2"
          onClick={() => setPref("oceanMotion", !motion)}
        >
          {motion ? "Pause motion" : "Play motion"}
        </button>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        {treatments.map(({ tone, title, description }) => (
          <section key={tone}>
            <div className="ocean-preview">
              <DitherField tone={tone} />
              <div className="relative p-6">
                <h2 className="text-title font-medium">
                  What are we working on?
                </h2>
                <p className="mt-2 text-faint">Your next idea starts here.</p>
              </div>
              <textarea
                rows={2}
                aria-label={`${title} draft`}
                placeholder="Type here to pause the water…"
                className="absolute inset-x-4 bottom-4 resize-none rounded-lg border border-border bg-popover p-3 outline-none"
              />
            </div>
            <div className="mt-4 flex items-center justify-between gap-3">
              <h2 className="text-title font-medium">{title}</h2>
              <button
                className="pressable rounded-md bg-fill-selected px-3 py-1.5"
                onClick={() => setPref("oceanTone", tone)}
              >
                {selected === tone ? "Selected" : "Use this color"}
              </button>
            </div>
            <p className="mt-2 text-muted-foreground">{description}</p>
          </section>
        ))}
      </div>
      <p className="mt-6 text-faint">
        Color and motion choices also appear in Mako’s Appearance settings. The
        engraving stays fixed. Only the small wake moves; reduced motion and
        hidden views pause it.
      </p>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Studies />)

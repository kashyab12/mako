import { Fragment, type ComponentType, type ReactNode } from "react"
import { useRegistry } from "@/extend/registry"
import { contributions, type SlotMap, type SlotName } from "@/extend/slots"

/**
 * Renders every contribution registered against a declared slot, in order.
 * Contributions are looked up through the registry hook, so one arriving late
 * — an extension loaded after boot — repaints exactly the seams it filled.
 */
export function Slot<K extends SlotName>(props: { name: K } & SlotMap[K]): ReactNode {
  const { name, ...rest } = props as { name: K } & Record<string, unknown>
  const registry = useRegistry(contributions)
  const matches = registry
    .entries()
    .filter(([, entry]) => entry.slot === name)
    .sort((a, b) => a[1].order - b[1].order)

  if (matches.length === 0) return null

  return (
    <>
      {matches.map(([id, entry]) => {
        const Contribution = entry.render as ComponentType<Record<string, unknown>>
        return (
          <Fragment key={id}>
            <Contribution {...rest} />
          </Fragment>
        )
      })}
    </>
  )
}

import type {
  RelayCompletion,
  RelayEventBatch,
  RelayJobPayload,
  RelayLease,
} from "./types"

export interface RelayDeliveryAdapter {
  start(input: {
    defaultHarness: string
    deviceId: string
    deviceName: string
    lease: RelayLease
  }): Promise<void>
  events(batch: RelayEventBatch): Promise<number>
  complete(input: {
    completion: RelayCompletion
    payload: RelayJobPayload
  }): Promise<void>
}

const adapters = new Map<string, RelayDeliveryAdapter>()

export function registerRelayDeliveryAdapter(
  provider: string,
  adapter: RelayDeliveryAdapter
): () => void {
  adapters.set(provider, adapter)
  return () => {
    if (adapters.get(provider) === adapter) adapters.delete(provider)
  }
}

export function relayDeliveryAdapter(provider: string): RelayDeliveryAdapter {
  const adapter = adapters.get(provider)
  if (!adapter) throw new Error(`No delivery adapter for ${provider}`)
  return adapter
}

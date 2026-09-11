import type { RailRanks } from "@/lib/thread-folders"
import { createStore } from "@/state/store"

/**
 * The rail's held recency, kept outside React so the next render can read
 * what the last one decided. `stableThreadRanks` freezes a busy thread's
 * rank; this is where the frozen value lives between renders.
 */
export const railRanksStore = createStore<{ ranks: RailRanks }>({ ranks: {} })

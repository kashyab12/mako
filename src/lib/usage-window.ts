export function usageWindowLabel(minutes: number): string {
  if (minutes === 300) return "5h"
  if (minutes === 10_080) return "week"
  if (minutes >= 1_440 && minutes % 1_440 === 0) {
    return `${minutes / 1_440}d`
  }
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

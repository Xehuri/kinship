export class NetworkFailoverTracker {
  private readonly attempted = new Set<string>()

  recordFailure(layerId: string | undefined): void {
    if (layerId !== undefined && layerId.length > 0) this.attempted.add(layerId)
  }

  canAttempt(totalLayers: number): boolean {
    if (totalLayers < 2) return false
    return this.attempted.size < totalLayers
  }

  getExclusions(): string[] {
    return [...this.attempted]
  }

  reset(): void {
    this.attempted.clear()
  }
}

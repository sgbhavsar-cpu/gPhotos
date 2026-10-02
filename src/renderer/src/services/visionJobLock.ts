// A tiny shared flag so the background AI auto-index loop (aiAutoIndexService.ts) and a
// user-triggered manual Smart Flow run never hammer the same local Ollama server at once — see
// docs/FEATURE_AI_AUTO_TAGGING.md §2.4. Cooperative, not enforced: a caller that doesn't check it
// just doesn't get the benefit, nothing breaks.
let manualFlowRunning = false;

export function setManualFlowRunning(running: boolean): void {
  manualFlowRunning = running;
}

export function isManualFlowRunning(): boolean {
  return manualFlowRunning;
}

/** Small, process-local status cache; no transcripts, workspace indexes, or credentials on disk. */
export const CODEX_PROGRESS_STATES = ["running", "waiting", "completed", "failed", "interrupted"] as const;
export type CodexProgressState = typeof CODEX_PROGRESS_STATES[number];
export type CodexProgress = {
  threadId: string;
  cwd?: string;
  turnId?: string;
  state: CodexProgressState;
  summary: string;
  updatedAt: string;
  source: "codex-mcp" | "app-server";
};

export class CodexProgressStore {
  private readonly entries = new Map<string, CodexProgress>();

  report(input: Omit<CodexProgress, "updatedAt">): CodexProgress {
    if (!input.threadId.trim() || input.threadId.length > 256) throw new Error("invalid threadId");
    if (!CODEX_PROGRESS_STATES.includes(input.state)) throw new Error("invalid progress state");
    if (!input.summary.trim() || input.summary.length > 4_000) throw new Error("summary must contain 1–4000 characters");
    if ((input.cwd?.length ?? 0) > 4_096 || (input.turnId?.length ?? 0) > 256) throw new Error("progress metadata too long");
    const progress = { ...input, updatedAt: new Date().toISOString() };
    this.entries.delete(input.threadId);
    this.entries.set(input.threadId, progress);
    while (this.entries.size > 200) this.entries.delete(this.entries.keys().next().value!);
    return progress;
  }

  list(threadId?: string): CodexProgress[] {
    return [...this.entries.values()].filter((entry) => threadId === undefined || entry.threadId === threadId).reverse();
  }
}

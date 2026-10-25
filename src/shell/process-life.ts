export type ProcessLifeCalls = {
  processAlive(pid: number): Promise<boolean>;
  processSignal(pid: number, signal: number): Promise<void>;
  processWatch(pid: number, token: number): Promise<void>;
  processUnwatch(token: number): Promise<void>;
};

/** Death recipients stay in their JVM; the owner keeps only session-bound tokens. */
export function remoteProcessLife(calls: () => ProcessLifeCalls, failed: (error: unknown) => void) {
  const recipients = new Map<number, () => void>();
  let nextToken = 1;
  return {
    alive: async (pid: number) => calls().processAlive(pid),
    signal: async (pid: number, signal: number) => calls().processSignal(pid, signal),
    watch: async (pid: number, died: () => void): Promise<() => void> => {
      const token = nextToken++;
      recipients.set(token, died);
      try { await calls().processWatch(pid, token); }
      catch (error) { recipients.delete(token); throw error; }
      return () => {
        if (recipients.delete(token)) void calls().processUnwatch(token).catch(failed);
      };
    },
    died(token: number) {
      const recipient = recipients.get(token);
      recipients.delete(token);
      recipient?.();
    },
    close() { recipients.clear(); },
  };
}

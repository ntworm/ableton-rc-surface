// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0

export interface ScheduledTask {
  targetKey: string;
  isDiscrete: boolean;
  value: number;
  execute: () => Promise<void>;
}

/**
 * WriteScheduler — Coalesces continuous control updates per targetKey while
 * preserving strict FIFO execution order for discrete (toggle, note, trigger)
 * events (Task 3.3 / ADR-004).
 */
export class WriteScheduler {
  private queues = new Map<string, ScheduledTask[]>();
  private isFlushing = false;

  /**
   * Enqueue a task for a targetKey.
   * If `isDiscrete` is false, coalesce with the previous task for the same targetKey
   * if the previous task is also continuous (non-discrete).
   */
  enqueue(task: ScheduledTask): void {
    const key = task.targetKey;
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    if (!task.isDiscrete && queue.length > 0) {
      const last = queue[queue.length - 1];
      if (last && !last.isDiscrete) {
        // Coalesce: replace stale continuous task with the newest value
        queue[queue.length - 1] = task;
        return;
      }
    }

    queue.push(task);
  }

  /**
   * Return number of pending tasks for a given targetKey (or total across all keys).
   */
  pendingCount(targetKey?: string): number {
    if (targetKey) {
      return this.queues.get(targetKey)?.length ?? 0;
    }
    let total = 0;
    for (const q of this.queues.values()) {
      total += q.length;
    }
    return total;
  }

  /**
   * Flush all pending tasks across all target queues in sequence.
   */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      const keys = Array.from(this.queues.keys());
      for (const key of keys) {
        const queue = this.queues.get(key);
        if (!queue || queue.length === 0) continue;

        // Drain the queue for this key in FIFO order
        while (queue.length > 0) {
          const task = queue.shift();
          if (task) {
            try {
              await task.execute();
            } catch (err) {
              console.error(
                `[WriteScheduler] Error executing task for ${key}:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
        this.queues.delete(key);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Clear all pending tasks without executing.
   */
  clear(): void {
    this.queues.clear();
  }
}

export const globalWriteScheduler = new WriteScheduler();

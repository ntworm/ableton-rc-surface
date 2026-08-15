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
   *
   * Callers enqueue and then immediately await flush(), so while one flush is
   * in flight every other flush() call returns straight away on the
   * `isFlushing` latch. Whatever those callers enqueued in that window has
   * nobody else to drain it: the outer loop therefore keeps sweeping until no
   * queue is left, instead of walking a key snapshot taken at entry. Without
   * it the last write of a gesture — the fader you just released, the hand
   * that just left the frame — sat in the map until some unrelated control
   * moved again.
   */
  async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    try {
      while (this.queues.size > 0) {
        for (const key of Array.from(this.queues.keys())) {
          const queue = this.queues.get(key);
          if (!queue || queue.length === 0) {
            this.queues.delete(key);
            continue;
          }

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
          // Only drop the queue if nothing was appended while we awaited.
          if (queue.length === 0 && this.queues.get(key) === queue) {
            this.queues.delete(key);
          }
        }
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

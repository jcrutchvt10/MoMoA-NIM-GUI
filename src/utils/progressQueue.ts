/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import WebSocket from 'ws';

const DEFAULT_PROGRESS_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

function getProgressUpdateTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.MOMOA_PROGRESS_UPDATE_TIMEOUT_MS ?? '',
    10,
  );

  if (Number.isFinite(configured) && configured >= 30_000) {
    return configured;
  }

  return DEFAULT_PROGRESS_UPDATE_TIMEOUT_MS;
}

interface ProgressQueueItem {
  id: number;
  resolved: boolean;
  value?: string;
  error?: boolean;
  addedAt: number;
}

export class ProgressQueue {
  private queue: ProgressQueueItem[] = [];
  private idCounter = 0;
  private readonly timeoutMs = getProgressUpdateTimeoutMs();

  constructor(
    private ws: WebSocket,
    private clientUUID: string
  ) {}

  add(message: string | Promise<string>) {
    const item: ProgressQueueItem = {
      id: this.idCounter++,
      resolved: false,
      addedAt: Date.now(),
    };
    
    this.queue.push(item);

    if (typeof message === 'string') {
      item.resolved = true;
      item.value = message;
      this.process();
    } else {
      // It's a Promise
      message
        .then(val => {
          item.resolved = true;
          item.value = val;
          queueMicrotask(() => this.process());
        })
        .catch(err => {
          console.error(`Progress update promise failed:`, err);
          item.error = true;
          // Capture the error message to send to the client
          item.value = err instanceof Error ? err.message : String(err);
          queueMicrotask(() => this.process());
        });

      // Add a small buffer so the timeout branch can trip deterministically.
      setTimeout(() => this.process(), this.timeoutMs + 50);
    }
  }

  process() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    while (this.queue.length > 0) {
      const head = this.queue[0];
      
      // 1. Handle Rejected Promises
      if (head.error) {
        try {
          this.ws.send(JSON.stringify({
            status: 'PROGRESS_UPDATES',
            completed_status_message: `Update failed: ${head.value}`,
          }));
        } catch (e) {
          console.error('Failed to send error update, will retry:', e);
          break; // Pause queue if socket throws an error
        }
        
        this.queue.shift();
        continue;
      }

      // 2. Handle Successfully Resolved Promises / Strings
      if (head.resolved) {
        try {
          this.ws.send(JSON.stringify({
            status: 'PROGRESS_UPDATES',
            completed_status_message: head.value,
            isError: false
          }));
        } catch (e) {
          console.error('Failed to send progress update, will retry:', e);
          break; 
        }
        
        this.queue.shift();
        continue;
      }

      // 3. Handle Timeouts
      const timeInQueue = Date.now() - head.addedAt;
      // Allow timeout if a subsequent item is resolved OR errored (both mean the future moved on)
      const hasFinishedSubsequent = this.queue.slice(1).some(q => q.resolved || q.error);

      if (timeInQueue >= this.timeoutMs - 100 && hasFinishedSubsequent) {
        console.log(
          `Sending timeout payload for unresolved progress update (client ${this.clientUUID}).`,
        );
        
        try {
          this.ws.send(JSON.stringify({
            status: 'PROGRESS_UPDATES',
            completed_status_message: `Update failed: Operation timed out after ${Math.round(this.timeoutMs / 1000)} seconds`,
          }));
        } catch (e) {
          console.error('Failed to send timeout update, will retry:', e);
          break;
        }

        this.queue.shift(); 
        continue;
      }

      // The head is unresolved and doesn't meet the skip criteria yet. Block the queue.
      break; 
    }
  }
}
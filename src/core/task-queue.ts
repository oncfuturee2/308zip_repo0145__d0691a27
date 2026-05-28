export interface DeliveryTask {
  id: string;
  eventId: string;
  endpointId: string;
  attemptNumber: number;
  executeAt: number;
}

export class TaskQueue {
  private tasks: DeliveryTask[] = [];

  push(task: DeliveryTask): void {
    this.tasks.push(task);
    this.tasks.sort((a, b) => a.executeAt - b.executeAt);
  }

  poll(): DeliveryTask | undefined {
    if (this.tasks.length === 0) {
      return undefined;
    }

    const now = Date.now();
    if (this.tasks[0].executeAt <= now) {
      return this.tasks.shift();
    }

    return undefined;
  }

  size(): number {
    return this.tasks.length;
  }

  clear(): void {
    this.tasks = [];
  }
}

import * as vscode from 'vscode';
import { ConnectionManager } from '../ssh/ConnectionManager';
import { Logger } from '../util/logger';

/**
 * Extension point for capabilities layered on top of a live SSH connection
 * (e.g. port forwarding, remote task runners). v1 ships none of these, but the
 * registry and lifecycle are in place so they can be added without touching the
 * transport or filesystem layers.
 */
export interface RemoteService extends vscode.Disposable {
  /** Stable id, e.g. "portForwarding". */
  readonly id: string;
  /** Called once after the service is registered. */
  activate(ctx: RemoteServiceContext): void | Promise<void>;
}

export interface RemoteServiceContext {
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  readonly subscriptions: vscode.Disposable[];
}

export class RemoteServiceRegistry implements vscode.Disposable {
  private readonly services = new Map<string, RemoteService>();

  constructor(private readonly ctx: RemoteServiceContext) {}

  async register(service: RemoteService): Promise<void> {
    if (this.services.has(service.id)) {
      throw new Error(`Remote service already registered: ${service.id}`);
    }
    this.services.set(service.id, service);
    await service.activate(this.ctx);
    this.ctx.logger.info(`Registered remote service: ${service.id}`);
  }

  get(id: string): RemoteService | undefined {
    return this.services.get(id);
  }

  dispose(): void {
    for (const service of this.services.values()) {
      service.dispose();
    }
    this.services.clear();
  }
}

// TODO(v2): implement and register PortForwardingService and RemoteTaskService here.

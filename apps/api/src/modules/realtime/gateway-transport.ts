import { Injectable } from '@nestjs/common';
import type { ServerToClientEvents } from '@ticketify/shared';
import { RealtimeGateway } from './realtime.gateway';
import { type EventPayload, RealtimeTransport } from './realtime-transport';

/**
 * API side: sends through the gateway's Socket.IO server. Its Redis adapter delivers to the
 * sockets of this instance at once and publishes for the other instances.
 */
@Injectable()
export class GatewayTransport extends RealtimeTransport {
  constructor(private readonly gateway: RealtimeGateway) {
    super();
  }

  emit<E extends keyof ServerToClientEvents>(
    room: string,
    event: E,
    payload: EventPayload<E>,
  ): void {
    this.gateway.server.to(room).emit(event, payload);
  }
}

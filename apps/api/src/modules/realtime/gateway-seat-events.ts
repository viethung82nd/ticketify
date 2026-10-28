import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { SeatEvents, type SeatEventName, type SeatEventPayload } from './seat-events';

/**
 * API side: sends through the gateway's Socket.IO server. Its Redis adapter delivers to the
 * sockets of this instance at once and publishes for the other instances.
 */
@Injectable()
export class GatewaySeatEvents extends SeatEvents {
  constructor(private readonly gateway: RealtimeGateway) {
    super();
  }

  protected emit(room: string, event: SeatEventName, payload: SeatEventPayload): void {
    this.gateway.server.to(room).emit(event, payload);
  }
}

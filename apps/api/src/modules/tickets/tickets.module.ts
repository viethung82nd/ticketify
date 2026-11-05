import { Module } from '@nestjs/common';
import { CheckInController } from './check-in.controller';
import { CheckInService } from './check-in.service';
import { TicketPdfStorage } from './ticket-pdf.storage';
import { TicketsController } from './tickets.controller';

/** Tickets on the API: downloading a booking's PDF (4.5) and check-in at the door (4.7). */
@Module({
  controllers: [TicketsController, CheckInController],
  providers: [TicketPdfStorage, CheckInService],
  exports: [TicketPdfStorage],
})
export class TicketsModule {}

/** Tickets in the worker: writing the PDF to storage, no controller. */
@Module({
  providers: [TicketPdfStorage],
  exports: [TicketPdfStorage],
})
export class TicketsWorkerModule {}

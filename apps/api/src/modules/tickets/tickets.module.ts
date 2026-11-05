import { Module } from '@nestjs/common';
import { TicketPdfStorage } from './ticket-pdf.storage';
import { TicketsController } from './tickets.controller';

/** Tickets on the API: downloading a booking's PDF (ROADMAP 4.5); check-in comes in 4.7. */
@Module({
  controllers: [TicketsController],
  providers: [TicketPdfStorage],
  exports: [TicketPdfStorage],
})
export class TicketsModule {}

/** Tickets in the worker: writing the PDF to storage, no controller. */
@Module({
  providers: [TicketPdfStorage],
  exports: [TicketPdfStorage],
})
export class TicketsWorkerModule {}

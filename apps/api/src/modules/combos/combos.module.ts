import { Module } from '@nestjs/common';
import { AdminCombosController, CombosController } from './combos.controller';
import { CombosService } from './combos.service';

/** Combos sold with tickets (ROADMAP 1.16). */
@Module({
  controllers: [CombosController, AdminCombosController],
  providers: [CombosService],
})
export class CombosModule {}

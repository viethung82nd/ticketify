import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type AdminCombo, type Combo, Role } from '@ticketify/shared';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CombosService } from './combos.service';
import { CreateComboDto, UpdateComboDto } from './dto/combo.dto';

const uuid = new ParseUUIDPipe();

@ApiTags('combos')
@Public()
@Controller('combos')
export class CombosController {
  constructor(private readonly combos: CombosService) {}

  @Get()
  @ApiOkResponse({ description: 'Active combos, by name' })
  list(): Promise<Combo[]> {
    return this.combos.listPublic();
  }
}

@ApiTags('admin: combos')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/combos')
export class AdminCombosController {
  constructor(private readonly combos: CombosService) {}

  @Get()
  @ApiOkResponse({ description: 'Every combo (active or not), by name, with booking counts' })
  list(): Promise<AdminCombo[]> {
    return this.combos.listAdmin();
  }

  @Post()
  @ApiCreatedResponse({ description: 'Created' })
  @ApiConflictResponse({ description: 'COMBO_NAME_TAKEN (ignoring case and diacritics)' })
  create(@Body() dto: CreateComboDto): Promise<AdminCombo> {
    return this.combos.create(dto);
  }

  @Patch(':id')
  @ApiOkResponse({ description: 'Updated; existing bookings keep their name/price snapshot' })
  @ApiNotFoundResponse({ description: 'COMBO_NOT_FOUND' })
  @ApiConflictResponse({ description: 'COMBO_NAME_TAKEN' })
  update(@Param('id', uuid) id: string, @Body() dto: UpdateComboDto): Promise<AdminCombo> {
    return this.combos.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'COMBO_NOT_FOUND' })
  @ApiConflictResponse({ description: 'COMBO_IN_USE: referenced by bookings, switch it off' })
  remove(@Param('id', uuid) id: string): Promise<void> {
    return this.combos.remove(id);
  }
}

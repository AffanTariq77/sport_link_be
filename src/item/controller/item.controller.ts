/** @author Shuja naqvi */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Public } from '../../auth/decorators/public.decorator';
import { ResponseType } from '../../common/decorators/response-type.decorator';
import Pagination, { IPaginationOptions } from '../../common/pagination-decorator';
import { ItemResponseDto } from '../../response-types/item-response.dto';
import { ItemPaginationResponseDto } from '../../response-types/pagination-response.dto';
import { OperationPrivilege } from '../../security/roles';
import { CreateItemDto } from '../dto/create-item.dto';
import { UpdateItemDto } from '../dto/update-item.dto';
import ItemAuthorizer from '../service/item.authorizer';
import { ItemService } from '../service/item.service';

@Controller('v1/items')
export class ItemController {
  constructor(
    private readonly itemAuthorizer: ItemAuthorizer,
    private readonly itemService: ItemService,
  ) {}

  @Public()
  @Get()
  @ResponseType(ItemPaginationResponseDto)
  async findAll(
    @Query('active') active: boolean | undefined,
    @Pagination() pagination: IPaginationOptions,
  ) {
    return this.itemService.findAll({ active, pagination });
  }

  @Post()
  @ResponseType(ItemResponseDto)
  async create(@Body() createItemDto: CreateItemDto) {
    return this.itemService.create(createItemDto);
  }

  @Public()
  @Get(':id')
  @ResponseType(ItemResponseDto)
  async findOne(@Param('id', ParseUUIDPipe) itemId: string) {
    await this.itemAuthorizer.assertCanAccess(itemId, OperationPrivilege.Public);
    return this.itemService.findOne(itemId);
  }

  @Put(':id')
  @ResponseType(ItemResponseDto)
  async update(
    @Param('id', ParseUUIDPipe) itemId: string,
    @Body() updateItemDto: UpdateItemDto,
  ) {
    await this.itemAuthorizer.assertCanAccess(itemId, OperationPrivilege.Edit);
    return this.itemService.update(itemId, updateItemDto);
  }

  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) itemId: string) {
    await this.itemAuthorizer.assertCanAccess(itemId, OperationPrivilege.Edit);
    return this.itemService.delete(itemId);
  }
}

/** @author Shuja naqvi */
import { Injectable } from '@nestjs/common';
import { IPaginationResponse } from '../../common/base-repository';
import { IPaginationOptions } from '../../common/pagination-decorator';
import { isDefined } from '../../common/utils';
import { CreateItemDto } from '../dto/create-item.dto';
import { UpdateItemDto } from '../dto/update-item.dto';
import { Item } from '../entity/item';
import { ItemRepository } from '../repository/item.repository';

export interface IGetItemsQuery {
  active?: boolean;
  pagination: IPaginationOptions;
}

@Injectable()
export class ItemService {
  constructor(private readonly itemRepository: ItemRepository) {}

  async findAll({ active, pagination }: IGetItemsQuery): Promise<IPaginationResponse<Item>> {
    return this.itemRepository.paginate(pagination, {
      order: { name: 'ASC' },
      where: isDefined(active) ? { active } : {},
    });
  }

  async create(createItemDto: CreateItemDto): Promise<Item> {
    const item = await this.itemRepository.save({
      ...createItemDto,
      description: createItemDto.description ?? '',
    });
    return this.findOne(item.id);
  }

  async update(itemId: string, updateItemDto: UpdateItemDto): Promise<Item> {
    await this.findOne(itemId);
    await this.itemRepository.update(itemId, updateItemDto);
    return this.findOne(itemId);
  }

  async delete(itemId: string): Promise<void> {
    await this.findOne(itemId);
    await this.itemRepository.update(itemId, { active: false, isDeleted: true });
  }

  async findOne(itemId: string): Promise<Item> {
    return this.itemRepository.findById(itemId);
  }
}

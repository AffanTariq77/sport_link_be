/** @author Shuja naqvi */
import { NotFoundException } from '@nestjs/common';
import { isEmpty } from 'lodash';
import { FindManyOptions, FindOneOptions, In, Repository } from 'typeorm';
import { BaseEntity } from './base-entity';
import { IPaginationOptions } from './pagination-decorator';

export interface IPaginationResponse<E> {
  items: E[];
  itemCount: number;
  pageCount: number;
  totalItems: number;
}

export class BaseRepository<E extends BaseEntity> extends Repository<E> {
  public async findById(id: string, options?: FindOneOptions<E>): Promise<E> {
    const obj = await this.findOne(id, options);
    if (isEmpty(obj)) {
      throw new NotFoundException(`${this.metadata.name} not found`);
    }
    return obj;
  }

  public async findMany(ids: string[], allOptions?: FindManyOptions<E>): Promise<E[]> {
    if (isEmpty(ids)) {
      return [];
    }
    const { where, ...options } = allOptions || {};
    return this.find({
      ...options,
      where: Object.assign(where || {}, {
        id: In(ids),
      }),
    });
  }

  public async paginate(
    { limit, page }: IPaginationOptions,
    options: FindManyOptions<E>,
  ): Promise<IPaginationResponse<E>> {
    if (page < 1) {
      return {
        items: [],
        itemCount: 0,
        pageCount: 0,
        totalItems: 0,
      };
    }
    const [items, totalItems] = await this.findAndCount({
      skip: limit * (page - 1),
      take: limit,
      ...options,
    });
    const pageCount = Math.ceil(totalItems / limit);
    return {
      items,
      itemCount: items.length,
      pageCount,
      totalItems,
    };
  }
}

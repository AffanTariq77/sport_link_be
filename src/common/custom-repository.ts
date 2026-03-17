/** @author Shuja naqvi */
import { FindManyOptions, FindOneOptions } from 'typeorm';
import { BaseEntity } from './base-entity';
import { BaseRepository } from './base-repository';
import { IPaginationOptions } from './pagination-decorator';

export class CustomRepository<E extends BaseEntity & { isDeleted: boolean }> extends BaseRepository<E> {
  public async findById(id: string, options?: FindOneOptions<E>): Promise<E> {
    return await super.findById(id, this.findOptions(options) as FindOneOptions<E>);
  }

  public async findMany(ids: string[], options?: FindManyOptions<E>): Promise<E[]> {
    return super.findMany(ids, this.findOptions(options) as FindManyOptions<E>);
  }

  public async paginate(pagination: IPaginationOptions, options: FindManyOptions<E>) {
    return await super.paginate(pagination, this.findOptions(options) as FindManyOptions<E>);
  }

  private findOptions(
    allOptions?: FindOneOptions<E> | FindManyOptions<E>,
  ): FindOneOptions<E> | FindManyOptions<E> {
    if (!allOptions) {
      return { where: { isDeleted: false } as FindOneOptions<E>['where'] };
    }
    const { where, ...options } = allOptions;
    return {
      ...options,
      where: Object.assign(where || {}, {
        isDeleted: false,
      }),
    };
  }
}

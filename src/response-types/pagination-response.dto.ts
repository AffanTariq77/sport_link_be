/** @author Shuja naqvi */
import { Expose, Type } from 'class-transformer';
import { ItemResponseDto } from './item-response.dto';

class BasePaginationResponseDto {
  @Expose()
  itemCount: number;

  @Expose()
  pageCount: number;

  @Expose()
  totalItems: number;
}

export class ItemPaginationResponseDto extends BasePaginationResponseDto {
  @Type(() => ItemResponseDto)
  @Expose()
  items: ItemResponseDto[];
}

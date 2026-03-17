/** @author Shuja naqvi */
import { Expose } from 'class-transformer';
import { BaseResponseDto } from './base-response.dto';

export class ItemResponseDto extends BaseResponseDto {
  @Expose()
  name: string;

  @Expose()
  description: string;

  @Expose()
  active: boolean;
}

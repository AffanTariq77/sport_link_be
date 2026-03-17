/** @author Shuja naqvi */
import { Expose } from 'class-transformer';

export class BaseResponseDto {
  @Expose()
  id: string;
}

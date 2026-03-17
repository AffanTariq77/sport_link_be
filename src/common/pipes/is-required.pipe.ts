/** @author Shuja naqvi */
import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';

@Injectable()
export class IsRequiredPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (value === undefined || value === null || value === '') {
      throw new BadRequestException(`${metadata.data} is a required parameter`);
    }
    return value;
  }
}

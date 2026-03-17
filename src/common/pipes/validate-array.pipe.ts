/** @author Shuja naqvi */
import {
  ArgumentMetadata,
  BadRequestException,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import { first, isEmpty } from 'lodash';

@Injectable()
export class ValidateArrayPipe<T> implements PipeTransform {
  readonly validItems: Set<T>;
  readonly optional: boolean;

  constructor(validItems: T[], { optional }: { optional?: boolean } = {}) {
    this.validItems = new Set(validItems);
    this.optional = !!optional;
  }

  async transform(value: T[], metadata: ArgumentMetadata): Promise<T[]> {
    if (this.optional && isEmpty(value)) {
      return value ?? [];
    }

    const errors = (value ?? [])
      .map((input) => (this.validItems.has(input) ? null : input))
      .filter((i) => i !== null);
    if (!isEmpty(errors)) {
      throw new BadRequestException(
        `${metadata.data} has invalid array member: ${String(first(errors))}`,
      );
    }
    return value ?? [];
  }
}

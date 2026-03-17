/** @author Shuja naqvi */
import {
  CallHandler,
  ClassSerializerInterceptor,
  ExecutionContext,
  NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { plainToClass } from 'class-transformer';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

type ClassType<T> = new () => T;

class TransformInterceptor<T> implements NestInterceptor<T, T> {
  constructor(private readonly classType: ClassType<T>) {}

  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<T> {
    const request = _context.switchToHttp().getRequest();

    return next.handle().pipe(
      map((data) =>
        plainToClass(this.classType, data, {
          excludeExtraneousValues: true,
          enableImplicitConversion: true,
          groups: request.responsePrivilegeGroups || [],
          strategy: 'excludeAll',
        }),
      ),
    );
  }
}

export const ResponseType = <T>(returnClass: ClassType<T>) =>
  UseInterceptors(
    new TransformInterceptor<T>(returnClass),
    ClassSerializerInterceptor,
  );

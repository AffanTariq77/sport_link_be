/** @author Shuja naqvi */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface IPaginationOptions {
  limit: number;
  page: number;
}

interface IPaginationQueryDefaults {
  defaultLimit?: number;
  defaultPage?: number;
}

const Pagination = createParamDecorator(
  (
    { defaultLimit = 10, defaultPage = 1 }: IPaginationQueryDefaults = {},
    ctx: ExecutionContext,
  ): IPaginationOptions => {
    const request = ctx.switchToHttp().getRequest();
    const limit = request.query.limit ?? defaultLimit;
    const page = request.query.page ?? defaultPage;
    return { limit: Number(limit), page: Number(page) };
  },
);

export default Pagination;

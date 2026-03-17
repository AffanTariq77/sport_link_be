/** @author Shuja naqvi */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface IRequestUser {
  id: string;
  email: string;
  role: string;
}

const RequestUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IRequestUser | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

export default RequestUser;

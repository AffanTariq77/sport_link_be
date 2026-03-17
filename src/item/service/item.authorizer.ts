/** @author Shuja naqvi */
import { Injectable, NotFoundException, Scope } from '@nestjs/common';
import IAuthorizer from '../../security/authorizer.interface';
import { OperationPrivilege } from '../../security/roles';
import { ItemRepository } from '../repository/item.repository';

@Injectable({ scope: Scope.REQUEST })
export default class ItemAuthorizer implements IAuthorizer {
  constructor(private readonly itemRepository: ItemRepository) {}

  async assertCanAccess(itemId: string, _minimumPrivilege: OperationPrivilege): Promise<void> {
    const item = await this.itemRepository.findOne(itemId, {
      loadEagerRelations: false,
      select: ['id'],
    });
    if (!item) {
      throw new NotFoundException('Item not found');
    }
  }
}

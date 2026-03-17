/** @author Shuja naqvi */
import { EntityRepository } from 'typeorm';
import { CustomRepository } from '../../common/custom-repository';
import { Item } from '../entity/item';

@EntityRepository(Item)
export class ItemRepository extends CustomRepository<Item> {}

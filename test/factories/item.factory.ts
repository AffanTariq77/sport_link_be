/** @author Shuja naqvi */
import { Factory } from 'fishery';
import { baseFactory } from './base.factory';
import { Item } from '../../src/item/entity/item';

export const itemFactory = Factory.define<Item>(() => ({
  ...baseFactory.build(),
  name: 'Test Item',
  description: 'Test description',
  active: true,
  isDeleted: false,
}));

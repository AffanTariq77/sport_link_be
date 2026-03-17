/** @author Shuja naqvi */
import { Factory } from 'fishery';
import { v4 as uuidv4 } from 'uuid';
import { BaseEntity } from '../../src/common/base-entity';

export const baseFactory = Factory.define<BaseEntity>(() => ({
  createdTime: new Date(),
  id: uuidv4(),
  modifiedTime: new Date(),
}));

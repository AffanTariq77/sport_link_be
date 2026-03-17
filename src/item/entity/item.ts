/** @author Shuja naqvi */
import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../common/base-entity';

@Entity()
export class Item extends BaseEntity {
  @Column()
  name: string;

  @Column({ default: '' })
  description: string;

  @Column({ default: true })
  active: boolean;

  @Column({ default: false })
  isDeleted: boolean;
}

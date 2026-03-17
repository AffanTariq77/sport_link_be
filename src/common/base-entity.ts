/** @author Shuja naqvi */
import {
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdTime: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  modifiedTime: Date;
}

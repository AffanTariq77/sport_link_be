/** @author Shuja naqvi */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ItemController } from './controller/item.controller';
import { ItemRepository } from './repository/item.repository';
import ItemAuthorizer from './service/item.authorizer';
import { ItemService } from './service/item.service';

@Module({
  imports: [TypeOrmModule.forFeature([ItemRepository])],
  providers: [ItemAuthorizer, ItemService],
  controllers: [ItemController],
})
export class ItemModule {}

/** @author Shuja naqvi */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { ItemRepository } from '../repository/item.repository';
import { ItemService } from './item.service';
import { Item } from '../entity/item';
import { CreateItemDto } from '../dto/create-item.dto';
import { UpdateItemDto } from '../dto/update-item.dto';

describe('ItemService', () => {
  let service: ItemService;
  let repository: jest.Mocked<Partial<ItemRepository>>;

  const mockItem: Item = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Test Item',
    description: 'Test description',
    active: true,
    isDeleted: false,
    createdTime: new Date(),
    modifiedTime: new Date(),
  };

  beforeEach(async () => {
    repository = {
      findById: jest.fn().mockResolvedValue(mockItem),
      findOne: jest.fn().mockResolvedValue(mockItem),
      findAndCount: jest.fn().mockResolvedValue([[mockItem], 1]),
      save: jest.fn().mockResolvedValue(mockItem),
      update: jest.fn().mockResolvedValue(undefined),
      paginate: jest.fn().mockResolvedValue({
        items: [mockItem],
        itemCount: 1,
        pageCount: 1,
        totalItems: 1,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ItemService,
        {
          provide: getRepositoryToken(ItemRepository),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get<ItemService>(ItemService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should return paginated items', async () => {
      const result = await service.findAll({
        pagination: { limit: 10, page: 1 },
      });
      expect(result.items).toHaveLength(1);
      expect(result.totalItems).toBe(1);
      expect(repository.paginate).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return an item by id', async () => {
      const result = await service.findOne(mockItem.id);
      expect(result).toEqual(mockItem);
      expect(repository.findById).toHaveBeenCalledWith(mockItem.id);
    });

    it('should throw NotFoundException when item not found', async () => {
      (repository.findById as jest.Mock).mockRejectedValue(new NotFoundException());
      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('should create an item', async () => {
      const dto: CreateItemDto = {
        name: 'New Item',
        description: 'New description',
        active: true,
      };
      (repository.save as jest.Mock).mockResolvedValue({ ...mockItem, ...dto });
      (repository.findById as jest.Mock).mockResolvedValue({ ...mockItem, ...dto });
      const result = await service.create(dto);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: dto.name, description: dto.description }),
      );
      expect(result.name).toBe(dto.name);
    });
  });

  describe('update', () => {
    it('should update an item', async () => {
      const dto: UpdateItemDto = { name: 'Updated Name' };
      (repository.findById as jest.Mock)
        .mockResolvedValueOnce(mockItem)
        .mockResolvedValueOnce({ ...mockItem, ...dto });
      const result = await service.update(mockItem.id, dto);
      expect(repository.update).toHaveBeenCalledWith(mockItem.id, dto);
      expect(result.name).toBe(dto.name);
    });
  });

  describe('delete', () => {
    it('should soft delete an item', async () => {
      await service.delete(mockItem.id);
      expect(repository.findById).toHaveBeenCalledWith(mockItem.id);
      expect(repository.update).toHaveBeenCalledWith(mockItem.id, {
        active: false,
        isDeleted: true,
      });
    });
  });
});

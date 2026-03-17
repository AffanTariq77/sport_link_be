/** @author Shuja naqvi */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateItemTable1700000000001 implements MigrationInterface {
  name = 'CreateItemTable1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "item" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdTime" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "modifiedTime" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "name" character varying NOT NULL,
        "description" character varying NOT NULL DEFAULT '',
        "active" boolean NOT NULL DEFAULT true,
        "isDeleted" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_item" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "item"`);
  }
}

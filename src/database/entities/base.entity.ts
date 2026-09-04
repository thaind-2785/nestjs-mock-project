import { CreateDateColumn, UpdateDateColumn } from 'typeorm';

// Audit/history rows extend this class directly so they never acquire an
// updated_at column that would suggest their append-only records can be edited.
export abstract class CreatedAtEntity {
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt!: Date;
}

// This is intentionally separate from TypeORM's BaseEntity: the application uses
// services/repositories (Data Mapper), not Active Record methods on domain entities.
export abstract class MutableEntity extends CreatedAtEntity {
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt!: Date;
}

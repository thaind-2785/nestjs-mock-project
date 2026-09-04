import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseConnectionService {
  private initialization: Promise<DataSource> | undefined;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async ensureInitialized(): Promise<DataSource> {
    if (this.dataSource.isInitialized) return this.dataSource;
    if (!this.initialization) {
      this.initialization = this.dataSource.initialize().finally(() => {
        this.initialization = undefined;
      });
    }
    return this.initialization;
  }
}

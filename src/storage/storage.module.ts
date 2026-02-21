import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { StorageFile, FileVersion, MultipartUpload } from './entities/storage-file.entity';
import { S3StorageProvider } from './providers/s3.provider';

@Module({
  imports: [TypeOrmModule.forFeature([StorageFile, FileVersion, MultipartUpload])],
  providers: [StorageService, S3StorageProvider],
  controllers: [StorageController],
  exports: [StorageService],
})
export class StorageModule {}

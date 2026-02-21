import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { DocumentHubService } from './document-hub.service';
import { Document } from './entities/document.entity';
import { DocumentVersion } from './entities/document-version.entity';
import { DocumentMetadata } from './entities/document-metadata.entity';
import { User } from '../iam/entities/user.entity';
import { OrchestrationModule } from '../orchestration/orchestration.module';
import { IamModule } from '../iam/iam.module';
import { SearchModule } from '../search/search.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentVersion, DocumentMetadata, User]),
    MulterModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        dest: './uploads',
        limits: {
          fileSize: configService.get('MAX_FILE_SIZE', 50 * 1024 * 1024),
        },
      }),
      inject: [ConfigService],
    }),
    OrchestrationModule,
    IamModule,
    SearchModule,
    AuditModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService, DocumentHubService],
  exports: [DocumentsService, DocumentHubService],
})
export class DocumentsModule {}

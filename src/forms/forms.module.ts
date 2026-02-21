import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormController } from './form.controller';
import { FormBuilderService } from './form-builder.service';
import { FormSchema } from './entities/form-schema.entity';
import { FormField } from './entities/form-field.entity';
import { FormSubmission } from './entities/form-submission.entity';
import { SearchModule } from '../search/search.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FormSchema, FormField, FormSubmission]),
    SearchModule,
    DocumentsModule,
    AuditModule,
  ],
  controllers: [FormController],
  providers: [FormBuilderService],
  exports: [FormBuilderService],
})
export class FormsModule {}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './core/filters/http-exception.filter';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Security Headers
  app.use(helmet());

  // 2. Rate Limiting
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
    }),
  );

  // 3. Global Prefix
  app.setGlobalPrefix('api/v1');

  // 4. Swagger Documentation
  const config = new DocumentBuilder()
    .setTitle('Meru Core API')
    .setDescription('Meru Core API with Supabase Database Integration')
    .setVersion('1.0')
    .addServer('http://localhost:3000', 'Development server')
    .addTag('app', 'Application status')
    .addTag('auth', 'Authentication endpoints')
    .addTag('crm', 'CRM endpoints')
    .addTag('iam', 'Identity and Access Management')
    .addTag('tenant', 'Tenant management')
    .addTag('search', 'Universal Search')
    .addTag('ai', 'AI Gateway')
    .addTag('documents', 'Document & Media Engine')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // 5. Global Validation Pipe (Auto-transform DTOs)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 6. Global Exception Filter
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(3000);
  console.log(`Application is running on: ${await app.getUrl()}`);
  console.log(`Swagger documentation available at: ${await app.getUrl()}/api`);
}
bootstrap();

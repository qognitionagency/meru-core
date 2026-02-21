# Meru Enterprise - Complete Platform Documentation

## 🎯 Platform Overview

**Meru Enterprise** is a multi-tenant, multi-vertical SaaS platform for internal team use across 3 vertical domains:

- **Meru Core Platform** - Main platform infrastructure
- **Immigration Vertical** - Immigration case management
- **GRC Vertical** - Governance, Risk & Compliance

### Architecture Highlights

```
┌─────────────────────────────────────────────────────────────────┐
│              Meru Enterprise Platform                      │
│                                                               │
│  Meru Core (api.meru.com)                                │
│  ├─ Production: api.meru.com                          │
│  ├─ Staging: staging-api.meru.com                     │
│  └─ Development: dev-api.meru.com                     │
│                                                               │
│  Immigration Vertical (api.immistack.com)                   │
│  ├─ Production: api.immistack.com                       │
│  ├─ Staging: staging-api.immistack.com                  │
│  └─ Development: dev-api.immistack.com                   │
│                                                               │
│  GRC Vertical (api.governancex.com)                         │
│  ├─ Production: api.governancex.com                       │
│  ├─ Staging: staging-api.governancex.com                  │
│  └─ Development: dev-api.governancex.com                  │
│                                                               │
│  Infrastructure:                                             │
│  ├─ 3 EC2 Instances (1 per vertical)                    │
│  ├─ 1 RDS PostgreSQL (Shared with RLS)                   │
│  ├─ 3 S3 Buckets (1 per vertical)                        │
│  ├─ Grafana + Prometheus Monitoring                          │
│  └─ GitHub Actions CI/CD                                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📋 Table of Contents

- [Architecture Overview](#architecture-overview)
- [Modules and Features](#modules-and-features)
- [API Documentation (Swagger)](#api-documentation)
- [Getting Started](#getting-started)
- [CI/CD Setup](#cicd-setup)
- [Deployment Guide](#deployment-guide)
- [Monitoring](#monitoring)
- [Security](#security)

---

## 🏗️ Architecture Overview

### Multi-Tenant with Row-Level Security (RLS)

**Strategy**: Shared Database + Database-Level Isolation via RLS

**Isolation Levels**:
- **Vertical Level**: immigration vs grc vs meru-core
- **Environment Level**: production vs staging vs development
- **Tenant Level**: Complete tenant isolation within vertical

**Database Schema**:
```sql
-- All tables have vertical and environment columns
documents {
  tenant_id: uuid,           -- For multi-tenancy
  vertical: varchar(50),       -- For vertical separation
  environment: varchar(20),     -- For env separation
  ...
}

-- RLS Policy ensures:
-- User can only see data matching:
--   1. Their tenant_id
--   2. Their assigned vertical
--   3. Their current environment
```

### Infrastructure Layers

```
Application Layer:
├── NestJS Application (Docker Container)
│   ├── Tenant Context Middleware (extracts vertical+env from domain)
│   ├── RBAC Guards (PolicyGuard, RolesGuard)
│   ├── Row-Level Security (PostgreSQL)
│   └── AI Orchestration Layer
│
└── Modules:
    ├── IAM (Authentication, Authorization, Tenant Management)
    ├── CRM (Universal Entities, Relationships)
    ├── Search (Keyword + Semantic Search)
    ├── AI (LLM Integration, Embeddings)
    ├── Documents (File Storage, Versioning, Encryption)
    ├── Orchestration (Cross-module coordination)
    └── Tenant Settings

Data Layer:
├── PostgreSQL (AWS RDS)
│   ├── 3 databases (meru_core, immigration_core, grc_core)
│   ├── Row-Level Security policies
│   └── Automated backups
│
└── Storage:
    ├── AWS S3 (3 buckets)
    │   ├── meru-documents
    │   ├── immigration-documents
    │   └── grc-documents
    └── Server-side encryption + AES-256-GCM

Infrastructure:
├── 3 EC2 Instances (1 per vertical)
├── Application Load Balancer (ALB)
├── Route 53 DNS
├── ACM SSL Certificates
└── CloudWatch + Grafana Monitoring
```

---

## 📦 Modules and Features

### 1. IAM (Identity & Access Management)

**Features**:
- JWT-based authentication
- Multi-provider authentication (Local, SAML, OIDC)
- Role-based access control (RBAC)
- Context-aware permissions
- Tenant management
- User management with vertical assignment

**API Endpoints**:
- `POST /api/v1/auth/login` - User login
- `POST /api/v1/auth/register` - User registration
- `GET /api/v1/auth/profile` - Get user profile
- `POST /api/v1/tenants/signup` - Create workspace
- `POST /api/v1/tenants/check-slug` - Check workspace availability
- `PATCH /api/v1/tenants/:id/upgrade` - Upgrade workspace plan
- `GET /api/v1/tenants/:id/stats` - Workspace statistics

### 2. CRM (Customer Relationship Management)

**Features**:
- Universal entities (Person, Organization)
- Vertical-specific attributes (dynamic schema)
- Entity relationships graph
- Version tracking
- Bulk operations

**API Endpoints**:
- `POST /api/v1/crm/entities` - Create entity
- `GET /api/v1/crm/entities` - Get all entities
- `GET /api/v1/crm/entities/:id` - Get entity by ID
- `PATCH /api/v1/crm/entities/:id` - Update entity
- `DELETE /api/v1/crm/entities/:id` - Delete entity

### 3. Documents (Document & Media Engine)

**Features**:
- Universal file storage (PDF, JPG, DOCX, XLSX, TXT)
- Version control (v1, v2, v3+ tracking)
- AES-256-GCM encryption at rest
- S3 integration with presigned URLs
- Entity linking (link documents to any record)
- AI-powered document analysis
- Full-text + semantic search
- Context-aware RBAC (read/write/delete/share permissions)
- Metadata extraction (EXIF, OCR, custom)

**API Endpoints**:
- `POST /api/v1/documents/upload` - Upload document with file
- `POST /api/v1/documents` - Create document record (no file)
- `POST /api/v1/documents/:id/versions` - Create new version
- `GET /api/v1/documents` - Search documents
- `GET /api/v1/documents/:id` - Get document details
- `GET /api/v1/documents/:id/versions` - Get all versions
- `GET /api/v1/documents/:id/versions/:versionId` - Get specific version
- `GET /api/v1/documents/:id/download` - Get download URL
- `GET /api/v1/documents/entity/:entityType/:entityId` - Get documents linked to entity
- `PATCH /api/v1/documents/:id` - Update document
- `DELETE /api/v1/documents/:id` - Soft delete document
- `POST /api/v1/documents/:id/analyze` - Trigger AI analysis

### 4. Search (Universal Search)

**Features**:
- Keyword search
- Semantic search (AI-powered)
- Hybrid search (keyword + semantic)
- Faceted search (filter by type, vertical, tags)
- Search across entities and documents

**API Endpoints**:
- `GET /api/v1/search` - Perform search
- `GET /api/v1/search/semantic` - Semantic search only
- `GET /api/v1/search/keyword` - Keyword search only

### 5. AI (AI Gateway & Orchestration)

**Features**:
- LLM integration (OpenAI GPT-4o)
- Vector embeddings for semantic search
- Prompt templates management
- Entity analysis and insights
- Document extraction
- Form validation

**API Endpoints**:
- `POST /api/v1/ai/execute` - Execute AI prompt
- `POST /api/v1/ai/analyze-entity/:id` - Analyze entity
- `POST /api/v1/ai/extract` - Extract data from document
- `POST /api/v1/ai/validate` - Validate form data
- `POST /api/v1/ai/embeddings` - Create embedding
- `GET /api/v1/ai/search` - Semantic search
- `GET /api/v1/ai/prompts` - Get available prompts
- `POST /api/v1/ai/prompts` - Create/update prompt

### 6. Orchestration (Cross-Module Coordination)

**Features**:
- Entity event handling
- Automatic search indexing
- Automatic AI analysis
- Intelligent search (keyword + semantic)
- Auto-categorization
- Insight extraction
- Bulk operations

**API Endpoints**:
- `GET /api/v1/orchestration/health` - Health check
- `GET /api/v1/orchestration/search/intelligent` - Intelligent search
- `GET /api/v1/orchestration/entity/:id/insights` - Get entity insights
- `POST /api/v1/orchestration/entity/:id/categorize` - Auto-categorize

### 7. Tenant Settings

**Features**:
- Tenant configuration management
- Vertical-specific settings
- Branding customization
- Feature flags
- Rate limiting configuration
- Security settings

---

## 📚 API Documentation (Swagger)

All API endpoints are documented with **Swagger/OpenAPI** and available at:
- **Development**: `http://dev-api.meru.com/api`
- **Staging**: `https://staging-api.meru.com/api`
- **Production**: `https://api.meru.com/api`

### Swagger Configuration

**Base Configuration**:
```typescript
// src/main.ts
const config = new DocumentBuilder()
  .setTitle('Meru Enterprise API')
  .setDescription('Multi-tenant SaaS platform with 3 verticals')
  .setVersion('1.0.0')
  .addServer('http://localhost:3000', 'Development server')
  .addServer('https://dev-api.meru.com', 'Meru Core Development')
  .addServer('https://api.meru.com', 'Meru Core Production')
  .addTag('app', 'Application status')
  .addTag('auth', 'Authentication endpoints')
  .addTag('iam', 'Identity and Access Management')
  .addTag('tenants', 'Tenant management')
  .addTag('crm', 'CRM endpoints')
  .addTag('search', 'Universal Search')
  .addTag('ai', 'AI Gateway')
  .addTag('documents', 'Document & Media Engine')
  .addTag('orchestration', 'Cross-module coordination')
  .addTag('health', 'Health checks')
  .addBearerAuth('JWT-auth', 'JWT token authentication')
  .build();

const document = SwaggerModule.createDocument(app, config);
SwaggerModule.setup('api', app, document);
```

**Swagger Decorators**:
All controllers use:
- `@ApiTags('tag')` - Groups endpoints by module
- `@ApiOperation({ summary: '' })` - Describes each endpoint
- `@ApiResponse({ status, description })` - Documents responses
- `@ApiQuery({ name, description })` - Query parameters
- `@ApiBody({ type, description })` - Request body schemas
- `@ApiBearerAuth('JWT-auth')` - Requires authentication
- `@UseGuards(JwtAuthGuard, RolesGuard)` - Protects endpoints
- `@Roles('role')` - Role-based access control

### API Authentication

**Login Flow**:
```bash
# 1. Get JWT Token
curl -X POST https://api.meru.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@meru.com",
    "password": "password"
  }'

# Response:
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": "1h"
}

# 2. Use Token in Requests
curl -X GET https://api.meru.com/api/v1/documents \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v18 or higher
- **pnpm**: v8 or higher
- **Docker**: Latest version
- **AWS Account**: With EC2, RDS, S3, Route53 access
- **GitHub Account**: For CI/CD
- **Domains**: meru.com, immistack.com, governancex.com

### Installation

```bash
# Clone repository
git clone https://github.com/your-org/meru-core.git
cd meru-core

# Install dependencies
pnpm install

# Setup environment variables
cp .env.example .env
# Edit .env with your AWS credentials and database details
```

### Local Development

```bash
# Start with hot-reload
pnpm run start:dev

# Or with debugging
pnpm run start:debug

# Or in production mode
pnpm run start:prod
```

### Environment Variables

```bash
# Core Configuration
NODE_ENV=development
PORT=3000
VERTICAL=meru

# AWS RDS (from Secrets Manager)
AWS_REGION=ap-south-1
AWS_RDS_SECRET_NAME=rds!db-4fd76536-90f2-4bd6-8da2-370b56d1312f

# Database (fallback for local development)
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USERNAME=postgres
DATABASE_PASSWORD=your-password
DATABASE_NAME=meru_core

# JWT
JWT_SECRET=your-jwt-secret-change-in-production
JWT_EXPIRATION=1h

# AWS Services
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_S3_BUCKET=meru-documents

# AI
OPENAI_API_KEY=your-openai-api-key

# Documents
DOCUMENT_ENCRYPTION_KEY=your-32-character-encryption-key-here
MAX_FILE_SIZE=52428800
```

---

## 🔄 CI/CD Setup

### GitHub Actions Configuration

**Workflow File**: `.github/workflows/enterprise-cicd.yml`

**Pipeline Triggers**:
```yaml
on:
  push:
    branches: [main, develop, staging]
  pull_request:
    branches: [main, develop, staging]
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [dev, staging, prod]
```

**Jobs**:
1. **Build & Test** - Runs on every push/PR
2. **Deploy to Development** - Auto-deploys on `develop` branch
3. **Deploy to Staging** - Auto-deploys on `staging` branch
4. **Deploy to Production** - Manual deployment on `main` branch

### GitHub Secrets Required

Add these to your repository settings:

**General Secrets**:
```
EC2_SSH_PRIVATE_KEY: -----BEGIN RSA PRIVATE KEY-----
EC2_SSH_USER: ec2-user
AWS_ACCESS_KEY_ID: your-aws-access-key-id
AWS_SECRET_ACCESS_KEY: your-aws-secret-access-key
AWS_REGION: ap-south-1
SLACK_WEBHOOK_URL: https://hooks.slack.com/...
```

**Meru Core EC2**:
```
MERU_EC2_HOST: meru-core-ec2-public-ip.compute.amazonaws.com
```

**Immigration EC2**:
```
IMMIGRATION_EC2_HOST: immigration-ec2-public-ip.compute.amazonaws.com
```

**GRC EC2**:
```
GRC_EC2_HOST: grc-ec2-public-ip.compute.amazonaws.com
```

### CI/CD Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│                 CI/CD Pipeline Flow                     │
│                                                            │
│  Developer pushes code                                      │
│         ↓                                                  │
│  ┌─────────────────────┐                              │
│  │ 1. Build & Test   │                              │
│  │   - Install deps    │                              │
│  │   - Run linter      │                              │
│  │   - Type check      │                              │
│  │   - Unit tests      │                              │
│  │   - Build Docker    │                              │
│   │   - Security scan  │                              │
│  └─────────────────────┘                              │
│         ↓                                                  │
│  Branch determines deployment:                              │
│    ├─ develop       → Deploy to all dev containers    │
│    ├─ staging       → Deploy to all staging containers   │
│    └─ main          → Deploy to all prod containers      │
│         ↓                                                  │
│  ┌─────────────────────┐                              │
│  │ 2. Deploy         │                              │
│  │   - SSH to EC2s    │                              │
│  │   - Git pull          │                              │
│  │   - Docker compose up  │                              │
│  │   - Health checks     │                              │
│  └─────────────────────┘                              │
│         ↓                                                  │
│  All 3 EC2s updated (9 containers total)             │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚢 Deployment Guide

### Architecture Summary

**3 EC2 Instances**, each running 3 Docker containers (dev, staging, production):

```
EC2 1: Meru Core (t3.medium)
├─ meru-prod:3000    → api.meru.com
├─ meru-staging:3000 → staging-api.meru.com
└─ meru-dev:3000     → dev-api.meru.com

EC2 2: Immigration (t3.medium)
├─ immigration-prod:3000    → api.immistack.com
├─ immigration-staging:3000 → staging-api.immistack.com
└─ immigration-dev:3000     → dev-api.immistack.com

EC2 3: GRC (t3.medium)
├─ grc-prod:3000           → api.governancex.com
├─ grc-staging:3000       → staging-api.governancex.com
└─ grc-dev:3000            → dev-api.governancex.com
```

### Deployment Steps

#### Option A: Automated CI/CD (Recommended)

```bash
# 1. Push code
git add .
git commit -m "Your commit message"
git push origin main  # For production
# OR
git push origin develop  # For development
# OR
git push origin staging  # For staging

# 2. CI/CD automatically:
#    - Builds Docker image
#    - Runs tests
#    - Deploys to all 3 EC2s
#    - Runs health checks
#    - Monitors for 60 seconds
#    - Notifies on Slack
```

#### Option B: Manual Deployment

```bash
# 1. SSH to specific EC2
ssh -i your-key.pem ec2-user@meru-core-ec2-ip.compute.amazonaws.com

# 2. Pull latest code
cd /var/www/meru-core
git pull origin main

# 3. Rebuild containers
docker-compose -f docker-compose.meru.yml up -d --build

# 4. Verify health
curl http://localhost:3000/api/v1/health
```

### Docker Compose Files

**Meru Core** (`docker-compose.meru.yml`):
```yaml
version: '3.8'

services:
  meru-prod:
    build: .
    container_name: meru-prod
    environment:
      - NODE_ENV=production
      - VERTICAL=meru
      - PORT=3000
    ports:
      - "3000:3000"
    restart: unless-stopped
    networks:
      - meru-network

  meru-staging:
    build: .
    container_name: meru-staging
    environment:
      - NODE_ENV=staging
      - VERTICAL=meru
      - PORT=3000
    ports:
      - "3001:3000"
    restart: unless-stopped
    networks:
      - meru-network

  meru-dev:
    build: .
    container_name: meru-dev
    environment:
      - NODE_ENV=development
      - VERTICAL=meru
      - PORT=3000
    ports:
      - "3002:3000"
    restart: unless-stopped
    networks:
      - meru-network

  # Monitoring
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"
    networks:
      - meru-network

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD}
    volumes:
      - grafana-data:/var/lib/grafana
    networks:
      - meru-network
```

**Immigration** (`docker-compose.immigration.yml`):
- Same structure, but `VERTICAL=immigration`

**GRC** (`docker-compose.grc.yml`):
- Same structure, but `VERTICAL=grc`

### Dockerfile

```dockerfile
# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@8

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm run build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

RUN apk add --no-cache dumb-init

RUN addgroup -g 1001 -S nodejs
RUN adduser -S nestjs -u 1001

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./

USER nestjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/v1/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

---

## 📊 Monitoring (Grafana)

### Access Grafana

```
Meru Core:     http://meru-ec2-ip:3001
Immigration:     http://immigration-ec2-ip:3001
GRC:             http://grc-ec2-ip:3001

Default Login:
  Username: admin
  Password: See .env files
```

### Monitoring Dashboards

1. **All Verticals - Uptime**: Which containers are up/down
2. **Response Time**: Monitor API response times per vertical
3. **Request Rate**: Track requests per environment (dev/staging/prod)
4. **Memory Usage**: Monitor memory per container
5. **CPU Usage**: Monitor CPU per container
6. **Error Rate**: Track 4xx/5xx errors
7. **Documents**: Track documents uploaded per vertical

### Prometheus Metrics

**Application Metrics**:
```yaml
# Collects from application endpoints
- http_request_duration_ms
- http_requests_total
- up (container uptime)
- container_memory_usage_bytes
- container_cpu_usage_seconds_total
```

**Container Metrics**:
```yaml
# Docker container stats
- container_cpu_usage_seconds_total{name=~"meru-prod|immigration-prod|grc-prod"}
- container_memory_usage_bytes{name=~"meru-prod|immigration-prod|grc-prod"}
```

---

## 🔒 Security

### Application Security

- **Authentication**: JWT-based with configurable expiration
- **Authorization**: Role-based access control (RBAC)
- **Context-Aware Permissions**: Vertical + Environment isolation
- **Rate Limiting**: 100 requests/15 minutes per IP
- **Input Validation**: Class-validator on all inputs
- **Security Headers**: Helmet.js (CSP, HSTS, etc.)
- **Password Hashing**: bcrypt (salt rounds: 10)

### Database Security

- **Row-Level Security**: Complete tenant isolation at database level
- **SSL/TLS**: All connections encrypted
- **Secrets Management**: AWS Secrets Manager
- **Backups**: Automated daily backups (30-day retention)
- **No Plain Text**: No passwords in code

### Infrastructure Security

- **VPC Isolation**: All resources in private VPC
- **Security Groups**: Restricted access (IP whitelisting)
- **SSH Key-Based**: No password authentication
- **IAM Roles**: Least privilege principle
- **SSL Certificates**: ACM-managed wildcards
- **Encryption at Rest**: S3 AES-256 + Application AES-256-GCM

### Document Security

- **S3 Server-Side Encryption**: AES-256
- **Application-Level Encryption**: AES-256-GCM for sensitive files
- **Presigned URLs**: Time-limited access (1 hour default)
- **File Type Validation**: Restricts to allowed types
- **Size Limits**: Max file size enforcement

---

## 💰 Cost Breakdown

### Monthly Infrastructure Costs

| Component | Cost/Month |
|-----------|------------|
| **EC2 (3 × t3.medium)** | $90 |
| **RDS PostgreSQL** | $75 |
| **S3 Storage (3 buckets)** | ~$7 |
| **ALB Load Balancer** | $42 |
| **Route 53 (3 zones)** | ~$3 |
| **ACM Certificates** | $0 |
| **Secrets Manager** | ~$1.20 |
| **CloudWatch** | ~$15 |
| **GitHub Actions** | $0 |
| **TOTAL** | **~$233/month** |

### Cost Optimization

1. **Reserved Instances**: 1-year commitment saves ~36%
2. **S3 Lifecycle**: Move old data to Glacier
3. **CloudWatch Metrics**: Use custom metrics strategically
4. **Database Storage**: Monitor and right-size

---

## 🧪 Testing

### Unit Tests

```bash
# Run all tests
pnpm run test

# Watch mode
pnpm run test:watch

# Coverage
pnpm run test:cov
```

### E2E Tests

```bash
# Run E2E tests
pnpm run test:e2e

# With coverage
pnpm run test:e2e --coverage
```

### Linting

```bash
# Check code style
pnpm run lint

# Auto-fix issues
pnpm run lint -- --fix
```

---

## 🐛 Troubleshooting

### Container Won't Start

```bash
# Check logs
docker logs meru-prod

# Check if port is in use
netstat -tuln | grep 3000

# Restart container
docker restart meru-prod
```

### Database Connection Failed

```bash
# Check RDS status
aws rds describe-db-instances \
  --db-instance-identifier meru-core-prod

# Check security group allows access
aws ec2 describe-security-groups \
  --group-ids $SECURITY_GROUP_ID
```

### DNS Not Resolving

```bash
# Check Route 53 records
aws route53 list-resource-record-sets \
  --hosted-zone-id $HOSTED_ZONE_ID

# Check NS records (update your domain registrar)
aws route53 get-hosted-zone \
  --hosted-zone-id $HOSTED_ZONE_ID
```

### Monitoring Not Showing Data

```bash
# Check if Prometheus is running
docker ps | grep prometheus

# Check Prometheus configuration
curl http://localhost:9090/api/v1/targets

# Check Grafana data source
# Grafana UI → Configuration → Data Sources → Prometheus
```

---

## 📚 Additional Documentation

- **Swagger API Docs**: Available at `/api` endpoint when running
- **Database Schema**: See `/src/migrations/` for table definitions
- **RLS Policies**: See migration `AddVerticalAndEnvironmentRLS.ts`
- **Module Documentation**: Each module has inline documentation

---

## 🚀 Quick Start Guide

### For Developers

```bash
# 1. Clone and setup
git clone https://github.com/your-org/meru-core.git
cd meru-core
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings

# 3. Start development server
pnpm run start:dev

# 4. Access API docs
open http://localhost:3000/api
```

### For Deployment

```bash
# 1. Add GitHub Secrets (see CI/CD section)
# 2. Push code
git push origin main

# 3. CI/CD auto-deploys to all 3 EC2s

# 4. Verify deployment
curl https://api.meru.com/api/v1/health
curl https://api.immistack.com/api/v1/health
curl https://api.governancex.com/api/v1/health
```

---

## 📞 Support

- **GitHub Issues**: https://github.com/your-org/meru-core/issues
- **Grafana Dashboard**: http://meru-ec2-ip:3001
- **Health Checks**: http://api.meru.com/api/v1/health

---

## 📄 License

UNLICENSED

---

## 🎯 Platform Status

| Component | Status | URL |
|-----------|--------|-----|
| **Meru Core API** | ✅ Operational | https://api.meru.com/api |
| **Immigration API** | ✅ Operational | https://api.immistack.com/api |
| **GRC API** | ✅ Operational | https://api.governancex.com/api |
| **API Documentation** | ✅ Available | https://api.meru.com/api |
| **Grafana Monitoring** | ✅ Operational | http://meru-ec2-ip:3001 |
| **CI/CD Pipeline** | ✅ Active | GitHub Actions |

---

**Last Updated**: February 3, 2026
**Version**: 1.0.0

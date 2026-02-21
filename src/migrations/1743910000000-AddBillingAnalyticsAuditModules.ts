import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBillingAnalyticsAuditModules1743910000000 implements MigrationInterface {
  name = 'AddBillingAnalyticsAuditModules1743910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ==================== BILLING MODULE ====================

    // Create billing_plans table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS billing_plans (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        billing_model VARCHAR(20) NOT NULL,
        interval VARCHAR(20) DEFAULT 'monthly',
        base_price DECIMAL(10, 2) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        features JSONB DEFAULT '{}',
        metered_pricing JSONB DEFAULT '{}',
        tax_config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_billing_plans_tenant_status ON billing_plans(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_billing_plans_tenant_model ON billing_plans(tenant_id, billing_model)
    `);

    // Create subscriptions table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        entity_id VARCHAR(36) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        plan_id UUID NOT NULL REFERENCES billing_plans(id),
        status VARCHAR(20) DEFAULT 'trialing',
        trial_ends_at TIMESTAMP,
        current_period_start TIMESTAMP NOT NULL,
        current_period_end TIMESTAMP NOT NULL,
        cancelled_at TIMESTAMP,
        ended_at TIMESTAMP,
        usage JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_status ON subscriptions(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant_entity ON subscriptions(tenant_id, entity_id)
    `);

    // Create usage_records table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS usage_records (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        subscription_id UUID NOT NULL REFERENCES subscriptions(id),
        usage_type VARCHAR(50) NOT NULL,
        quantity DECIMAL(10, 4) NOT NULL,
        unit_price DECIMAL(10, 4) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        description TEXT,
        metadata JSONB DEFAULT '{}',
        timestamp TIMESTAMP NOT NULL,
        invoiced BOOLEAN DEFAULT false,
        invoice_id UUID,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_subscription ON usage_records(tenant_id, subscription_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_type ON usage_records(tenant_id, usage_type)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_usage_records_tenant_timestamp ON usage_records(tenant_id, timestamp)
    `);

    // Create credit_ledger table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS credit_ledger (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        subscription_id UUID NOT NULL REFERENCES subscriptions(id),
        transaction_type VARCHAR(20) NOT NULL,
        amount DECIMAL(15, 4) NOT NULL,
        balance DECIMAL(15, 4) NOT NULL,
        description TEXT,
        metadata JSONB DEFAULT '{}',
        expiry_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant_subscription ON credit_ledger(tenant_id, subscription_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant_type ON credit_ledger(tenant_id, transaction_type)
    `);

    // Create invoices table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        invoice_number VARCHAR(100) UNIQUE NOT NULL,
        subscription_id UUID NOT NULL REFERENCES subscriptions(id),
        status VARCHAR(20) DEFAULT 'draft',
        period_start TIMESTAMP NOT NULL,
        period_end TIMESTAMP NOT NULL,
        due_date TIMESTAMP NOT NULL,
        paid_at TIMESTAMP,
        subtotal DECIMAL(10, 2) DEFAULT 0,
        tax_amount DECIMAL(10, 2) DEFAULT 0,
        discount_amount DECIMAL(10, 2) DEFAULT 0,
        credit_applied DECIMAL(10, 2) DEFAULT 0,
        total DECIMAL(10, 2) DEFAULT 0,
        amount_due DECIMAL(10, 2) DEFAULT 0,
        amount_paid DECIMAL(10, 2) DEFAULT 0,
        tax_details JSONB DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_invoices_tenant_status ON invoices(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_invoices_tenant_subscription ON invoices(tenant_id, subscription_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_invoices_tenant_due_date ON invoices(tenant_id, due_date)
    `);

    // Create invoice_items table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        invoice_id UUID NOT NULL REFERENCES invoices(id),
        type VARCHAR(20) NOT NULL,
        description VARCHAR(500) NOT NULL,
        amount DECIMAL(10, 2) NOT NULL,
        quantity DECIMAL(10, 2) DEFAULT 1,
        unit_price DECIMAL(10, 4) NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ==================== ANALYTICS MODULE ====================

    // Create reports table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        report_type VARCHAR(20) NOT NULL,
        data_source VARCHAR(20) NOT NULL,
        configuration JSONB NOT NULL,
        schedule JSONB DEFAULT '{}',
        is_public BOOLEAN DEFAULT true,
        created_by VARCHAR(36) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_tenant_status ON reports(tenant_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_tenant_source ON reports(tenant_id, data_source)
    `);

    // Create report_executions table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS report_executions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        report_id UUID NOT NULL REFERENCES reports(id),
        executed_at TIMESTAMP NOT NULL,
        executed_by VARCHAR(36) NOT NULL,
        parameters JSONB DEFAULT '{}',
        results JSONB,
        row_count INTEGER DEFAULT 0,
        execution_time_ms DECIMAL(10, 2) DEFAULT 0,
        status VARCHAR(20) DEFAULT 'success',
        error_message TEXT,
        file_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_report_executions_tenant_report ON report_executions(tenant_id, report_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_report_executions_tenant_executed ON report_executions(tenant_id, executed_at)
    `);

    // Create dashboard_widgets table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS dashboard_widgets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        widget_type VARCHAR(20) NOT NULL,
        configuration JSONB NOT NULL,
        position INTEGER DEFAULT 0,
        is_default BOOLEAN DEFAULT true,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_tenant_status ON dashboard_widgets(tenant_id, status)
    `);

    // ==================== AUDIT MODULE ====================

    // Create audit_logs table (WORM - Write Once, Read Many)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id VARCHAR(36) NOT NULL,
        vertical VARCHAR(50),
        environment VARCHAR(20),
        timestamp TIMESTAMP NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        user_email VARCHAR(255),
        user_role VARCHAR(100),
        action VARCHAR(50) NOT NULL,
        entity_type VARCHAR(100) NOT NULL,
        entity_id VARCHAR(36) NOT NULL,
        description TEXT,
        severity VARCHAR(20) DEFAULT 'info',
        before_state JSONB,
        after_state JSONB,
        changes JSONB DEFAULT '[]',
        context JSONB DEFAULT '{}',
        compliance_standard VARCHAR(50),
        compliance_metadata JSONB DEFAULT '{}',
        checksum VARCHAR(64),
        archived BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_timestamp ON audit_logs(tenant_id, timestamp)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_entity ON audit_logs(tenant_id, entity_type, entity_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_user ON audit_logs(tenant_id, user_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action ON audit_logs(tenant_id, action)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_compliance ON audit_logs(tenant_id, compliance_standard)
    `);

    // Enable RLS on all new tables
    await queryRunner.query(`
      ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
      ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
      ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
      ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
      ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
      ALTER TABLE report_executions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE dashboard_widgets ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    `);

    // Create RLS policies for new tables
    await queryRunner.query(`
      CREATE POLICY vertical_env_isolation_billing_plans ON billing_plans
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_subscriptions ON subscriptions
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_usage_records ON usage_records
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_credit_ledger ON credit_ledger
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_invoices ON invoices
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_invoice_items ON invoice_items
        FOR ALL USING (
          EXISTS (
            SELECT 1 FROM invoices i
            WHERE i.id = invoice_items.invoice_id
            AND app.has_access(i.vertical, i.environment)
          )
        );

      CREATE POLICY vertical_env_isolation_reports ON reports
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_report_executions ON report_executions
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_dashboard_widgets ON dashboard_widgets
        FOR ALL USING (app.has_access(vertical, environment));

      CREATE POLICY vertical_env_isolation_audit_logs ON audit_logs
        FOR ALL USING (app.has_access(vertical, environment));
    `);

    // Create triggers for vertical/environment fields
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_context_fields_billing_plans ON billing_plans;
      CREATE TRIGGER set_context_fields_billing_plans BEFORE INSERT OR UPDATE ON billing_plans
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_subscriptions ON subscriptions;
      CREATE TRIGGER set_context_fields_subscriptions BEFORE INSERT OR UPDATE ON subscriptions
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_usage_records ON usage_records;
      CREATE TRIGGER set_context_fields_usage_records BEFORE INSERT OR UPDATE ON usage_records
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_credit_ledger ON credit_ledger;
      CREATE TRIGGER set_context_fields_credit_ledger BEFORE INSERT OR UPDATE ON credit_ledger
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_invoices ON invoices;
      CREATE TRIGGER set_context_fields_invoices BEFORE INSERT OR UPDATE ON invoices
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_reports ON reports;
      CREATE TRIGGER set_context_fields_reports BEFORE INSERT OR UPDATE ON reports
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_report_executions ON report_executions;
      CREATE TRIGGER set_context_fields_report_executions BEFORE INSERT OR UPDATE ON report_executions
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_dashboard_widgets ON dashboard_widgets;
      CREATE TRIGGER set_context_fields_dashboard_widgets BEFORE INSERT OR UPDATE ON dashboard_widgets
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();

      DROP TRIGGER IF EXISTS set_context_fields_audit_logs ON audit_logs;
      CREATE TRIGGER set_context_fields_audit_logs BEFORE INSERT OR UPDATE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION app.set_context_fields();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop triggers
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS set_context_fields_billing_plans ON billing_plans;
      DROP TRIGGER IF EXISTS set_context_fields_subscriptions ON subscriptions;
      DROP TRIGGER IF EXISTS set_context_fields_usage_records ON usage_records;
      DROP TRIGGER IF EXISTS set_context_fields_credit_ledger ON credit_ledger;
      DROP TRIGGER IF EXISTS set_context_fields_invoices ON invoices;
      DROP TRIGGER IF EXISTS set_context_fields_reports ON reports;
      DROP TRIGGER IF EXISTS set_context_fields_report_executions ON report_executions;
      DROP TRIGGER IF EXISTS set_context_fields_dashboard_widgets ON dashboard_widgets;
      DROP TRIGGER IF EXISTS set_context_fields_audit_logs ON audit_logs;
    `);

    // Drop RLS policies
    await queryRunner.query(`
      DROP POLICY IF EXISTS vertical_env_isolation_billing_plans ON billing_plans;
      DROP POLICY IF EXISTS vertical_env_isolation_subscriptions ON subscriptions;
      DROP POLICY IF EXISTS vertical_env_isolation_usage_records ON usage_records;
      DROP POLICY IF EXISTS vertical_env_isolation_credit_ledger ON credit_ledger;
      DROP POLICY IF EXISTS vertical_env_isolation_invoices ON invoices;
      DROP POLICY IF EXISTS vertical_env_isolation_invoice_items ON invoice_items;
      DROP POLICY IF EXISTS vertical_env_isolation_reports ON reports;
      DROP POLICY IF EXISTS vertical_env_isolation_report_executions ON report_executions;
      DROP POLICY IF EXISTS vertical_env_isolation_dashboard_widgets ON dashboard_widgets;
      DROP POLICY IF EXISTS vertical_env_isolation_audit_logs ON audit_logs;
    `);

    // Disable RLS
    await queryRunner.query(`
      ALTER TABLE billing_plans DISABLE ROW LEVEL SECURITY;
      ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;
      ALTER TABLE usage_records DISABLE ROW LEVEL SECURITY;
      ALTER TABLE credit_ledger DISABLE ROW LEVEL SECURITY;
      ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;
      ALTER TABLE invoice_items DISABLE ROW LEVEL SECURITY;
      ALTER TABLE reports DISABLE ROW LEVEL SECURITY;
      ALTER TABLE report_executions DISABLE ROW LEVEL SECURITY;
      ALTER TABLE dashboard_widgets DISABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
    `);

    // Drop tables in reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS dashboard_widgets CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS report_executions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS reports CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS invoice_items CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS invoices CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS credit_ledger CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS usage_records CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS subscriptions CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS billing_plans CASCADE`);
  }
}

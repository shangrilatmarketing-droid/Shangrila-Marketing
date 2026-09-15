-- Each user and plan is a separate PostgreSQL row. JSONB preserves legacy
-- fields; generated columns make the main fields visible/queryable in pgAdmin.
CREATE TABLE users (
  email text PRIMARY KEY,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  password_hash text GENERATED ALWAYS AS (document->>'password') STORED,
  is_admin boolean GENERATED ALWAYS AS (COALESCE((document->>'isAdmin')::boolean, false)) STORED,
  is_approved boolean GENERATED ALWAYS AS (COALESCE((document->>'isApproved')::boolean, true)) STORED,
  CHECK (email = lower(document->>'email'))
);
CREATE TABLE plans (
  id text PRIMARY KEY,
  sort_order integer NOT NULL CHECK (sort_order >= 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  title text GENERATED ALWAYS AS (document->>'title') STORED,
  company text GENERATED ALWAYS AS (document->>'company') STORED,
  plan_date text GENERATED ALWAYS AS (document->>'date') STORED,
  status text GENERATED ALWAYS AS (COALESCE(document->>'status', 'pending')) STORED,
  cost numeric GENERATED ALWAYS AS (COALESCE(NULLIF(document->>'cost', '')::numeric, 0)) STORED,
  CHECK (id = document->>'id'),
  CHECK (cost >= 0)
);
CREATE INDEX plans_order_idx ON plans(sort_order, id);
CREATE INDEX plans_status_date_idx ON plans(status, plan_date);
CREATE INDEX plans_company_idx ON plans(company);
CREATE TABLE company_budgets (
  company text PRIMARY KEY,
  annual_budget numeric(18,2) NOT NULL CHECK (annual_budget >= 0)
);
CREATE TABLE plan_uploads (
  filename text PRIMARY KEY,
  content_type text NOT NULL,
  file_data bytea NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_digest_deliveries (
  email text NOT NULL,
  delivery_date text NOT NULL,
  sent_at timestamptz,
  lease_until timestamptz,
  claim_token uuid,
  PRIMARY KEY (email, delivery_date)
);
CREATE TABLE data_imports (
  id text PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL
);

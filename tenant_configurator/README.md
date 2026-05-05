# MarktRadar Tenant Configurator

Light, configuration-driven Python module that handles per-tenant customer
definition and data ingestion for MarktRadar. New tenants require one YAML
file; no code changes.

## Install

```bash
cd tenant_configurator
python -m pip install -e .
```

Python 3.11+ required. Dependencies: pydantic v2, pyyaml, pandas, openpyxl,
rapidfuzz, click.

## First run (Van Ameyde tenant)

```bash
# Generate the bundled dummy data once (150 European insurers,
# ~80 contacts per source file). Skip if already present.
python scripts/generate_van_ameyde_data.py

# Ingest the XLS contact file:
marktradar-ingest --tenant van-ameyde \
    --source tenants/van-ameyde/data/sample_xls_contacts.xlsx

# Or the ZOHO CRM export (forces the zoho_crm_export adapter):
marktradar-ingest --tenant van-ameyde \
    --source tenants/van-ameyde/data/sample_zoho_export.csv \
    --adapter zoho_crm_export
```

Output lands in `output/klantbeeld_<tenant>_<timestamp>.json`. Use `--dry-run`
to validate without writing.

## Add a new tenant (no code changes)

```bash
# 1. Scaffold the folder + a default config.yaml:
marktradar-init-tenant --id my-tenant --naam "My Tenant BV"

# 2. Drop a reference list of customers into:
#       tenants/my-tenant/data/INSTELLING_LIJST.txt
#    Format: `id | naam | hoofdvestiging` per line; '#' for comments.

# 3. Edit tenants/my-tenant/config.yaml:
#       - field_mapping per source adapter (column header -> canonical field)
#       - contact_role_mapping (job title fragment -> rol)
#       - GDPR rules

# 4. Ingest:
marktradar-ingest --tenant my-tenant --source path/to/your_file.xlsx
```

That is the full onboarding for a new tenant. Adding a third or thirtieth
tenant is the same three-step flow.

## Tests

```bash
python -m pytest --cov=marktradar
```

47 tests covering the pipeline, adapters, mapping, GDPR rules, the resolver,
and CLI. Coverage sits around 90%. Two tenants ship by default
(`van-ameyde` and `demo`) which lets a single test prove that adding a tenant
does not require code changes.

## Architecture (5-stage pipeline)

1. **Load** tenant YAML; pydantic validates strictly.
2. **Read** the source file; one adapter per format (xlsx, csv, json).
3. **Map** source columns to canonical fields per `field_mapping`. Rows
   carry both klant-level and contact-level data: keys with the
   `_contact.` prefix become a `Contactpersoon`; keys with `velden.`
   become tenant-specific custom fields on the customer.
4. **Resolve** the customer name to a canonical id via exact, slug, then
   fuzzy match (rapidfuzz token_set_ratio against the
   `INSTELLING_LIJST`). Below the threshold, the id falls back to a
   slug derived from the name.
5. **Validate + write**. Each customer is upserted into the index by
   id; multiple source rows for the same customer merge into a single
   record with deduplicated contacts. GDPR rules apply (free-mail
   downgrade, private-phone removal). Output is JSON.

## What's out of scope (v2)

- LLM fallback for ambiguous matches
- REST API on top of the pipeline
- Web UI for editing tenant configs
- Realtime CRM sync via webhook
- Multi-language taxonomies beyond NL/EN

# Year-End Invoice & PO Auditor (n8n Blueprint Bundle)

Self-hosted, deterministic invoice-to-PO audit pipeline built on **n8n**, **Vision LLM extraction** (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `temperature: 0`), a **deterministic JavaScript audit engine**, **Telegram HITL approvals**, and **dead-letter error recovery**.

## Contents

- `workflows/`
  - `Invoice_PO_Auditor_Main.json` (17 nodes) — Form Trigger → SHA-256 hash & size/type guardrail → PDF rasterization → Vision extraction → Deterministic JS audit → Auto-approve (`Approved_Ledger` + Gmail) or HITL (`Pending_Approvals` + Telegram)
  - `Invoice_PO_Auditor_Approval_Responder.json` (13 nodes) — Webhook (`POST /webhook/telegram-approval-reply`) → `APPROVE <INV>` / `REJECT <INV>` → `Approved_Ledger` + `Pending_Approvals` update
  - `Invoice_PO_Auditor_Error_Handler.json` (4 nodes) — `Error Trigger` → `Audit_Errors` dead-letter insert + HTML-escaped Telegram ops alert
- `pdf-service/` — Lightweight Python `ThreadingHTTPServer` + PyMuPDF (`:5681`) that rasterizes page 1 of uploaded PDFs at 150 DPI (~98 ms/page)
- `seed-data/` — Sample invoices (`INV-2026-101.pdf`, `INV-2026-102.pdf`, `INV-2026-101-duplicate.pdf`) and `PO_Master.csv` / `PO_Master.json`

> **Note:** No API keys, OAuth tokens, or credential secrets are included in this bundle.

---

## 5-Step Setup

### 1. Install n8n
Install n8n (v2.x+) with `crypto` enabled for Code-node SHA-256 hashing:
```bash
npm install -g n8n
export NODE_FUNCTION_ALLOW_BUILTIN=crypto
n8n start
```
Open `http://127.0.0.1:5678` and complete initial local owner setup.

### 2. Import Workflows & Create Data Tables
Import the three JSON files from `workflows/` via **Workflows → Import from File** (or `n8n import:workflow --input=...`):
1. `workflows/Invoice_PO_Auditor_Main.json`
2. `workflows/Invoice_PO_Auditor_Error_Handler.json`
3. `workflows/Invoice_PO_Auditor_Approval_Responder.json`

Create the four n8n Data Tables (or swap the Data Table nodes for Google Sheets / Postgres) and import `seed-data/PO_Master.csv` into `PO_Master`:
- `PO_Master` (`po_number`, `vendor_name`, `currency`, `authorized_amount`, `remaining_amount`, `status`)
- `Approved_Ledger` (`invoice_number`, `vendor_name`, `po_number`, `stated_total`, `computed_total`, `variance`, `status`, `flags`, `file_hash`, `reviewer_id`, `approved_at`, `submitted_by`)
- `Pending_Approvals` (same columns as `Approved_Ledger` plus `status`, `requested_at`, `decided_at`)
- `Audit_Errors` (`execution_id`, `workflow_name`, `failed_node`, `error_message`, `file_hash`, `execution_url`, `timestamp`)

### 3. Set Up the NVIDIA Credential (Required) + Optional Notifications
In n8n **Credentials → Add Credential**:
- **OpenAI API** (`openAiApi`):
  - **Base URL:** `https://integrate.api.nvidia.com/v1`
  - **API Key:** Your NVIDIA NIM API key (`nvapi-...`)
  - Attach this credential to the `Extract Invoice via NVIDIA` node in `Invoice_PO_Auditor_Main`.
- *(Optional for full notifications/HITL)* Add a **Telegram API** credential (`telegramApi`) and update `chatId` on `Send Approval Request` / `Confirm to Charles` / `Alert Ops Channel`, plus a **Gmail OAuth2** credential on `Notify Submitter (Clean)`.

### 4. Start `pdf-service`
```bash
cd pdf-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
bash start.sh
curl -s http://127.0.0.1:5681/health
```
Expected: `{"status": "ok", "renderer": "pymupdf", ...}`.

### 5. Activate & Run
Publish/activate all three workflows in n8n, then open the live form at:
`http://127.0.0.1:5678/form/invoice-po-auditor-form`

Test the three branches with `seed-data/`:
- `INV-2026-101.pdf` → Clean match (`PO-5001`, `$1,000.00`) → `APPROVED_AUTO`
- `INV-2026-102.pdf` → Line-item math error (`4 × $250 = $1,150`) + PO overrun → `Pending_Approvals` + Telegram HITL card
- `INV-2026-101-duplicate.pdf` → Identical SHA-256 hash → `DUPLICATE_INVOICE` flagged for review

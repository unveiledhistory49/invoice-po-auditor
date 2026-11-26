# Year-End Invoice & PO Auditor (n8n Blueprint Bundle)

Self-hosted, deterministic invoice-to-PO audit pipeline built on **n8n**, **Vision LLM extraction** (`nvidia/nemotron-3.5-super-vl-120b-a12b`, `temperature: 0`), a **deterministic JavaScript audit engine**, **Telegram HITL approvals**, and **dead-letter error recovery**.

## Contents

- `workflows/`
  - `Invoice_PO_Auditor_Main.json` (17 nodes) — Form Trigger → SHA-256 hash & size/type guardrail → PDF rasterization → Vision extraction → Deterministic JS audit → Auto-approve (`Approved_Ledger` + `Notify Submitter (Clean)`) or HITL (`Pending_Approvals` + `Send Approval Request`)
  - `Invoice_PO_Auditor_Approval_Responder.json` (13 nodes) — Webhook (`POST /webhook/telegram-approval-reply`) → `APPROVE <INV>` / `REJECT <INV>` → `Approved_Ledger` + `Pending_Approvals` update + `Confirm Decision` (`Notify Submitter (HITL)` is a `NoOp` placeholder for your own email/Slack follow-up)
  - `Invoice_PO_Auditor_Error_Handler.json` (4 nodes) — `Error Trigger` → `Audit_Errors` dead-letter insert + HTML-escaped Telegram ops alert
- `pdf-service/` — Lightweight Python `ThreadingHTTPServer` + PyMuPDF (`:5681`) that rasterizes page 1 of uploaded PDFs at 150 DPI (~98 ms/page)
- `telegram-poller/` — Outbound-only Telegram `getUpdates` long-poller (`poller.js`, `start.sh`) that forwards `APPROVE <INV>` / `REJECT <INV>` text replies (one-tap copy via `<code>` blocks) to n8n's `POST /webhook/telegram-approval-reply` without needing a public URL
- `seed-data/` — Sample invoices (`INV-2026-101.pdf`, `INV-2026-102.pdf`, `INV-2026-101-duplicate.pdf`, and Naira sample `INV-2026-201.pdf`) plus `PO_Master.csv` / `PO_Master.json`

> **Note:** No API keys, OAuth tokens, personal Telegram chat IDs, or instance-specific Data Table / credential IDs are included in this bundle. All workflow JSONs and `telegram-poller/poller.js` use `YOUR_*` placeholders.

---

## 6-Step Setup

### 1. Install n8n
Install n8n (v2.x+) with `crypto` enabled for Code-node SHA-256 hashing:
```bash
npm install -g n8n
export NODE_FUNCTION_ALLOW_BUILTIN=crypto
n8n start
```
Open `http://127.0.0.1:5678` and complete initial local owner setup.

### 2. Create Data Tables & Re-bind Nodes
Create the four n8n Data Tables (or swap the Data Table nodes for Google Sheets / Postgres) and import `seed-data/PO_Master.csv` into `PO_Master`:
- `PO_Master` (`po_number`, `vendor_name`, `currency`, `authorized_amount`, `remaining_amount`, `status`)
- `Approved_Ledger` (`invoice_number`, `vendor_name`, `po_number`, `invoice_date`, `currency`, `stated_total`, `computed_total`, `po_variance`, `status`, `reviewer_id`, `file_hash`, `submitter_email`, `flags_json`, `processed_at`)
- `Pending_Approvals` (`invoice_number`, `vendor_name`, `po_number`, `invoice_date`, `currency`, `stated_total`, `computed_total`, `po_variance`, `status`, `reviewer_id`, `file_hash`, `submitter_email`, `flags_json`, `requested_at`, `decided_at`)
- `Audit_Errors` (`execution_id`, `workflow_name`, `failed_node`, `error_message`, `file_hash`, `execution_url`, `timestamp`)

Import the three JSON files from `workflows/` via **Workflows → Import from File**:
1. `workflows/Invoice_PO_Auditor_Main.json`
2. `workflows/Invoice_PO_Auditor_Error_Handler.json`
3. `workflows/Invoice_PO_Auditor_Approval_Responder.json`

**Re-bind Data Table IDs:** Each workflow JSON contains placeholder table IDs (`YOUR_PO_MASTER_TABLE_ID`, `YOUR_APPROVED_LEDGER_TABLE_ID`, `YOUR_PENDING_APPROVALS_TABLE_ID`, `YOUR_AUDIT_ERRORS_TABLE_ID`). After importing, open each Data Table node in n8n and select your newly created table from the dropdown (or search-and-replace the placeholders with your table IDs before importing).

**Re-bind Error Workflow:** `Invoice_PO_Auditor_Main` and `Invoice_PO_Auditor_Approval_Responder` set `settings.errorWorkflow` to `'invoice-po-auditor-error-handler'`. Because importing via the n8n UI assigns a new workflow ID to `Invoice_PO_Auditor_Error_Handler`, open **Workflow Settings → Error Workflow** on both `Invoice_PO_Auditor_Main` and `Invoice_PO_Auditor_Approval_Responder` and select your imported `Invoice_PO_Auditor_Error_Handler` (and ensure `Log to Dead-Letter Table` and `Alert Ops Channel` inside the error handler are bound to your `Audit_Errors` table and Telegram credential).

> **Note on `Notify Submitter (HITL)`:** In `Invoice_PO_Auditor_Approval_Responder.json`, `Notify Submitter (HITL)` is intentionally a `NoOp` node so you can wire in your own email/Slack notification to the submitter after an approval or rejection decision.

### 3. Set Up Credentials & Telegram Chat ID
In n8n **Credentials → Add Credential**:
- **OpenAI API** (`openAiApi`):
  - **Base URL:** `https://integrate.api.nvidia.com/v1`
  - **API Key:** Your NVIDIA NIM API key (`nvapi-...`)
  - Attach this credential to `Extract Invoice via NVIDIA` in `Invoice_PO_Auditor_Main` (replacing `YOUR_NVIDIA_CREDENTIAL_ID`).
- *(Optional for full notifications/HITL)*
  - Add a **Telegram API** credential (`telegramApi`), attach it to `Send Approval Request`, `Confirm Decision`, and `Alert Ops Channel` (replacing `YOUR_TELEGRAM_CREDENTIAL_ID`), and replace `YOUR_TELEGRAM_CHAT_ID` with your Telegram chat ID.
  - Add a **Gmail OAuth2** credential on `Notify Submitter (Clean)` (replacing `YOUR_GMAIL_CREDENTIAL_ID`).

### 4. Start `pdf-service`
```bash
cd pdf-service
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
bash start.sh
curl -s http://127.0.0.1:5681/health
```
Expected: `{"status": "ok", "renderer": "pymupdf", ...}`.

### 5. Start `telegram-poller` (for Local HITL Replies)
**Prerequisites:** Node.js 18+ (the poller is a Node.js script) and the `sqlite3` CLI (for inspecting n8n's local database, e.g. verifying Data Table rows). Install them before running the poller.
`Invoice_PO_Auditor_Approval_Responder` listens on `POST http://127.0.0.1:5678/webhook/telegram-approval-reply`. On a local install without a public webhook URL, run the included outbound poller:
```bash
export TELEGRAM_CRED_ID="your-n8n-telegram-credential-id"
export TELEGRAM_CHAT_ID="your-telegram-chat-id"
export N8N_DIR="$HOME/.n8n"                # optional; defaults to $N8N_USER_FOLDER or $HOME/.n8n
export POLLER_DIR="$(pwd)/telegram-poller" # optional; defaults to the script directory
bash telegram-poller/start.sh
```
It decrypts your bot token in-memory from n8n's local credential store (`$N8N_DIR/config` and `$N8N_DIR/database.sqlite`), long-polls Telegram `getUpdates`, and forwards `APPROVE <INV>` / `REJECT <INV>` text replies to the responder webhook.

### 6. Activate & Run
Publish/activate all three workflows in n8n, then open the live form at:
`http://127.0.0.1:5678/form/invoice-po-auditor-form`

Test the three branches with `seed-data/`:
- `INV-2026-101.pdf` → Clean match (`PO-5001`, `$1,000.00`) → `APPROVED_AUTO`
- `INV-2026-102.pdf` → Line-item math error (`4 × $250 = $1,150`) + PO overrun → `Pending_Approvals` + Telegram HITL card
- `INV-2026-101-duplicate.pdf` → Identical SHA-256 hash → `DUPLICATE_INVOICE` flagged for review
- `INV-2026-201.pdf` → Sample Naira (`₦250,000.00`) Nigerian supplier invoice for NGN testing

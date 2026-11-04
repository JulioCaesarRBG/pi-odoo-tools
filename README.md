# pi-odoo-tools ⚡

[![Pi Package](https://img.shields.io/badge/pi--package-ready-blueviolet.svg)](https://pi.dev)
[![Odoo Support](https://img.shields.io/badge/Odoo-16%20%7C%2017%20%7C%2018-714B67.svg)](https://www.odoo.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6.svg)](https://www.typescriptlang.org)
[![Python](https://img.shields.io/badge/Python-3.10+-3776AB.svg)](https://www.python.org)

Native [Pi Coding Agent](https://pi.dev) extension for comprehensive **Odoo ERP** development, inspection, timesheet logging, and remote container deployment.

Replaces heavy MCP server daemons with a lightweight, high-performance in-process bridge that combines TypeScript native tools with a headless Python XML-RPC & Docker CLI execution runner.

---

## 🚀 Key Features

* **⚡ Zero-Daemon Native Bridge**: Executes Odoo XML-RPC and server operations instantly without persistent background MCP daemons or memory overhead.
* **🔍 Instant XML ID & View Finder**: Locates record IDs, view definitions (`form`, `list`, `kanban`), `inherit_id` references, and actions across local addons in milliseconds using ripgrep.
* **⏱️ Two-Phase Timesheet Sync**: Strict preview-before-commit workflow (`preview_timesheet` ➔ user approval ➔ `sync_timesheet`) with automatic engineer profile attribution when authenticating as admin.
* **🛡️ Built-in Credential Sanitization**: Automatically masks sensitive fields (`password`, `secret`, `apikey`, `token`, `otp`, `privatekey`) in all `search_read` responses.
* **📦 End-to-End Remote Deployment**: One-command module deployment: (1) remote SSH git pull, (2) container/service restart, (3) XML-RPC module upgrade, and (4) HTTP health check verification.
* **🛡️ Docker CLI Upgrade Fallback**: Survives Odoo 500 errors, missing database columns, and dependency deadlocks using isolated CLI upgrade (`odoo -u <module> --stop-after-init --no-http`).

---

## 📦 Installation

Add this package to your Pi Coding Agent environment with a single command:

```bash
pi install git:github.com/JulioCaesarRBG/pi-odoo-tools
```

Or try it temporarily in a single session:

```bash
pi -e git:github.com/JulioCaesarRBG/pi-odoo-tools
```

---

## ⚙️ Configuration

Copy `.env.example` to create target environment files for your Odoo instances (e.g. `.env_admin_demo`, `.env_admin`, `.env_admin_payroll`):

```bash
cp .env.example .env_admin
```

### Configuration Variables

| Variable | Description | Example |
| :--- | :--- | :--- |
| `ODOO_ADMIN_URL` / `ODOO_URL` | Odoo base URL | `https://odoo.example.com` |
| `ODOO_ADMIN_DB` / `ODOO_DB` | Database name | `odoo_prod` |
| `ODOO_ADMIN_USER` / `ODOO_USER` | Login email or username | `admin` |
| `ODOO_ADMIN_SECRET` / `ODOO_SECRET` | API Key or password | `your_secret_key` |
| `ODOO_TIMESHEET_USER_EMAIL` | Target user email for timesheet attribution | `engineer@example.com` |
| `ODOO_TIMESHEET_USER_NAME` | Target user name for timesheet attribution | `Jane Doe` |
| `ODOO_SSH_HOST` | Host IP for remote deployment | `192.168.1.50` |
| `ODOO_SSH_USER` | SSH username on host | `ubuntu` |
| `ODOO_SSH_PASS` | SSH password on host | `your_ssh_pass` |
| `ODOO_ADDONS_PATH` | Server addons path | `/home/ubuntu/odoo/addons` |
| `ODOO_HEALTH_URL` | Health check endpoint | `https://odoo.example.com/web/health` |
| `ODOO_CONTAINER` | Docker container name (Compose) | `odoo18` |
| `ODOO_SWARM_SERVICE` | Docker Swarm service name (Swarm) | `odoo_service` |

---

## 🛠️ Tools Reference

| Tool | Purpose | Safe / Read-Only |
| :--- | :--- | :---: |
| `odoo_find_xmlid` | Searches XML IDs, views, models, and inherit targets across addons | ✅ Yes |
| `odoo_fields` | Inspects ORM schema, field types, labels, and relations via `fields_get` | ✅ Yes |
| `odoo_search_read` | Queries records from specified model with domain filtering & credential masking | ✅ Yes |
| `odoo_search_count`| Returns total record count matching an Odoo domain filter | ✅ Yes |
| `odoo_list_projects` | Lists projects and IDs available for task or timesheet logging | ✅ Yes |
| `odoo_preview_timesheet` | Validates project allocations and hours without database writes | ✅ Yes |
| `odoo_sync_timesheet` | Commits approved timesheet entries (requires `user_confirmed: true`) | ⚠️ Write |
| `odoo_upgrade_module` | Triggers immediate module upgrade via XML-RPC | ⚠️ Write |
| `odoo_deploy_module` | Full deployment: SSH git pull + restart + DB upgrade + health check | ⚠️ Write |
| `odoo_cli_upgrade` | Direct container CLI upgrade with `--stop-after-init --no-http` | ⚠️ Write |

---

## 🔒 Security & Privacy

* **Zero Hardcoded Secrets**: All authentication tokens, passwords, and private network addresses are loaded exclusively from local environment files.
* **Sensitive Record Redaction**: Automatically scrubs authentication tokens, passwords, and API keys before returning query results to the LLM.
* **Approval Gates**: Destructive operations and production deployments strictly require explicit confirmation (`user_confirmed: true`).

---

## 📄 License

MIT License © 2026 [Julio Caesar Ray Bakar Gani](https://github.com/JulioCaesarRBG).
Contributions and pull requests are welcome!

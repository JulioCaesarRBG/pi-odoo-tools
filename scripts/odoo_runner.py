#!/usr/bin/env python3
"""
Odoo Runner CLI for Pi Coding Agent Native Extension
Provides JSON-based XML-RPC execution for:
- Timesheets (preview, sync, projects)
- Admin Read-Only operations (search_read, read, search_count) across Prod and Demo targets.
- Module Deployment & Upgrade
Self-contained XML-RPC execution without requiring FastMCP or MCP server daemons.
"""

import os
import sys
import json
import xmlrpc.client
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

def get_env_path(target="demo"):
    target_clean = (target or "demo").lower().strip()
    if target_clean in ("prod", "crm"):
        candidates = [
            os.path.join(SCRIPT_DIR, ".env_admin"),
            os.path.join(SCRIPT_DIR, ".env_prod"),
        ]
    elif target_clean in ("payroll", "payroll-demo", "payroll_demo"):
        candidates = [
            os.path.join(SCRIPT_DIR, ".env_admin_payroll"),
            os.path.join(SCRIPT_DIR, ".env_payroll"),
        ]
    else:
        candidates = [
            os.path.join(SCRIPT_DIR, ".env_admin_demo"),
            os.path.join(SCRIPT_DIR, ".env_demo"),
        ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]

def get_target_label(target="demo"):
    target_clean = (target or "demo").lower().strip()
    env_file = get_env_path(target_clean)
    if os.path.exists(env_file):
        load_dotenv(env_file, override=False)
    url = os.getenv("ODOO_ADMIN_URL") or os.getenv("ODOO_URL", "")
    return f"{target_clean.upper()} ({url})" if url else target_clean.upper()

def get_connection(target="demo"):
    target_clean = (target or "demo").lower().strip()
    env_file = get_env_path(target_clean)
    if os.path.exists(env_file):
        load_dotenv(env_file, override=True)
    
    url = os.getenv("ODOO_ADMIN_URL") or os.getenv("ODOO_URL")
    db = os.getenv("ODOO_ADMIN_DB") or os.getenv("ODOO_DB", target_clean)
    user = os.getenv("ODOO_ADMIN_USER") or os.getenv("ODOO_USER")
    secret = os.getenv("ODOO_ADMIN_SECRET") or os.getenv("ODOO_SECRET")
    
    if not url:
        raise PermissionError(f"Missing ODOO_URL or ODOO_ADMIN_URL in {env_file} for target '{target_clean}'")
    if not user or not secret:
        raise PermissionError(f"Missing user or secret in {env_file} for target '{target_clean}'")
        
    common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
    uid = common.authenticate(db, user, secret, {})
    if not uid:
        raise PermissionError(f"Authentication failed to {url} ({db}) for {user}")
        
    models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")
    return db, uid, secret, models

# Sensitive credential markers (inspired by mcp-server-odoo security patterns)
SENSITIVE_FIELD_MARKERS = (
    "password", "passwd", "pass", "secret", "apikey", "privatekey",
    "secretkey", "accesskey", "token", "rtoken", "passkey", "salt",
    "otp", "pin", "hashkey", "hashiv"
)

def is_sensitive_field(field_name):
    if not isinstance(field_name, str):
        return False
    name_lower = field_name.lower().strip()
    parts = name_lower.split('_')
    last_part = parts[-1].rstrip('0123456789')
    if last_part in SENSITIVE_FIELD_MARKERS:
        return True
    if any(name_lower.endswith('_' + m) or name_lower == m for m in SENSITIVE_FIELD_MARKERS):
        return True
    if any(marker in name_lower for marker in ("api_key", "secret_key", "access_key", "auth_token", "smtp_pass")):
        return True
    return False

def mask_sensitive_records(records):
    if isinstance(records, list):
        for rec in records:
            if isinstance(rec, dict):
                for k in list(rec.keys()):
                    if is_sensitive_field(k) and rec[k]:
                        rec[k] = "****** [MASKED_CREDENTIAL]"
    elif isinstance(records, dict):
        for k in list(records.keys()):
            if is_sensitive_field(k) and records[k]:
                records[k] = "****** [MASKED_CREDENTIAL]"
    return records

def get_requestor_person_id(db, uid, secret, models, person_name):
    if not person_name:
        return None
    partners = models.execute_kw(
        db, uid, secret, 'res.partner', 'search_read',
        [[['name', 'ilike', person_name]]],
        {'fields': ['id', 'name'], 'limit': 1}
    )
    return partners[0]['id'] if partners else None

def get_requestor_dept_id(db, uid, secret, models, dept_name):
    if not dept_name:
        return None
    depts = models.execute_kw(
        db, uid, secret, 'hr.department', 'search_read',
        [[['name', 'ilike', dept_name]]],
        {'fields': ['id', 'name'], 'limit': 1}
    )
    return depts[0]['id'] if depts else None

def list_projects(target="demo", name_filter=""):
    db, uid, secret, models = get_connection(target)
    domain = [('name', 'ilike', name_filter)] if name_filter else []
    return models.execute_kw(
        db, uid, secret, 'project.project', 'search_read',
        [domain], {'fields': ['id', 'name']}
    )

def resolve_timesheet_user_and_employee(db, uid, secret, models):
    """
    Resolves the actual user_id and employee_id for timesheet logging.
    If authenticated as Admin/system user, resolves via configured target user
    (ODOO_TIMESHEET_USER_EMAIL / ODOO_TIMESHEET_USER_NAME) so timesheet entries
    are correctly attributed to the engineer rather than generic Administrator.
    """
    user_records = models.execute_kw(
        db, uid, secret, 'res.users', 'search_read',
        [[['id', '=', uid]]],
        {'fields': ['id', 'login', 'name', 'employee_id']}
    )
    curr_user = user_records[0] if user_records else {}
    curr_login = (curr_user.get('login') or '').lower()

    target_user_id = None
    target_emp_id = None

    # If logged in as a normal user (not admin), attribute to self
    if curr_login and 'admin' not in curr_login and uid != 2:
        target_user_id = uid
        if curr_user.get('employee_id'):
            target_emp_id = curr_user['employee_id'][0]
        else:
            emps = models.execute_kw(
                db, uid, secret, 'hr.employee', 'search_read',
                [[['user_id', '=', uid]]],
                {'fields': ['id'], 'limit': 1}
            )
            if emps:
                target_emp_id = emps[0]['id']
        return target_user_id, target_emp_id

    # If logged in as admin or service user, resolve via configured target email/name
    target_email = os.getenv("ODOO_TIMESHEET_USER_EMAIL") or os.getenv("ODOO_USER_EMAIL")
    target_name = os.getenv("ODOO_TIMESHEET_USER_NAME") or os.getenv("ODOO_USER_NAME")

    if target_email or target_name:
        domain = []
        if target_email and target_name:
            domain = ['|', ['login', '=ilike', target_email], ['name', 'ilike', target_name]]
        elif target_email:
            domain = [['login', '=ilike', target_email]]
        else:
            domain = [['name', 'ilike', target_name]]

        matched_users = models.execute_kw(
            db, uid, secret, 'res.users', 'search_read',
            [domain],
            {'fields': ['id', 'name', 'employee_id'], 'limit': 1}
        )
        if matched_users:
            target_user_id = matched_users[0]['id']
            if matched_users[0].get('employee_id'):
                target_emp_id = matched_users[0]['employee_id'][0]

        # Resolve employee_id if not found via res.users
        if not target_emp_id and target_user_id:
            emps = models.execute_kw(
                db, uid, secret, 'hr.employee', 'search_read',
                [[['user_id', '=', target_user_id]]],
                {'fields': ['id'], 'limit': 1}
            )
            if emps:
                target_emp_id = emps[0]['id']

        # Fallback search hr.employee by name directly
        if not target_emp_id and target_name:
            emps = models.execute_kw(
                db, uid, secret, 'hr.employee', 'search_read',
                [[['name', 'ilike', target_name]]],
                {'fields': ['id', 'user_id'], 'limit': 1}
            )
            if emps:
                target_emp_id = emps[0]['id']
                if not target_user_id and emps[0].get('user_id'):
                    target_user_id = emps[0]['user_id'][0]

    # Extreme fallback: default to curr_user if specific target record is not resolved
    if not target_user_id:
        target_user_id = uid
    if not target_emp_id and curr_user.get('employee_id'):
        target_emp_id = curr_user['employee_id'][0]

    return target_user_id, target_emp_id

def preview_timesheet(date_str, tasks, target="demo"):
    db, uid, secret, models = get_connection(target)
    target_clean = (target or "demo").lower().strip()
    target_label = get_target_label(target_clean)
    target_user_id, target_emp_id = resolve_timesheet_user_and_employee(db, uid, secret, models)

    projects_raw = models.execute_kw(db, uid, secret, 'project.project', 'search_read', [[]], {'fields': ['id', 'name']})
    project_map = {p['name']: p['id'] for p in projects_raw}

    preview_items = []
    missing_projects = []
    total_hours = 0.0

    for item in tasks:
        proj_name = item.get('project_name', '')
        task_name = item.get('task_name', '')
        desc = item.get('description', '')
        hours = float(item.get('hours', 0))
        req_person = item.get('requestor_person', '')
        req_dept = item.get('requestor_department', '')
        total_hours += hours

        req_person_id = get_requestor_person_id(db, uid, secret, models, req_person) if req_person else None
        req_dept_id = get_requestor_dept_id(db, uid, secret, models, req_dept) if req_dept else None

        proj_id = project_map.get(proj_name)
        if not proj_id:
            missing_projects.append(proj_name)
            task_status = "PROJECT_NOT_FOUND"
            ts_status = "UNKNOWN"
        else:
            existing_tasks = models.execute_kw(
                db, uid, secret, 'project.task', 'search_read',
                [[['project_id', '=', proj_id], ['name', '=', task_name]]],
                {'fields': ['id', 'name']}
            )
            if existing_tasks:
                task_id = existing_tasks[0]['id']
                task_status = f"EXISTS (ID: {task_id})"
            else:
                task_status = "WILL_CREATE_NEW_TASK"
                task_id = None

            if task_id:
                ts_domain = [['date', '=', date_str], ['project_id', '=', proj_id], ['task_id', '=', task_id]]
                if target_user_id:
                    ts_domain.append(['user_id', '=', target_user_id])
                elif target_emp_id:
                    ts_domain.append(['employee_id', '=', target_emp_id])

                existing_ts = models.execute_kw(
                    db, uid, secret, 'account.analytic.line', 'search',
                    [ts_domain]
                )
                ts_status = "ALREADY_EXISTS (Will Skip)" if existing_ts else "WILL_ADD_NEW"
            else:
                ts_status = "WILL_ADD_NEW"

        preview_items.append({
            "project_name": proj_name,
            "project_id": proj_id,
            "task_name": task_name,
            "task_status": task_status,
            "description": desc,
            "hours": hours,
            "requestor_person": req_person or "None",
            "requestor_person_id": req_person_id,
            "requestor_department": req_dept or "None",
            "requestor_department_id": req_dept_id,
            "timesheet_action": ts_status
        })

    return {
        "status": "PREVIEW_READY",
        "target": target_label,
        "message": f"Preview generated successfully on [{target_label}]. Please present this to the user for explicit approval before running sync_timesheet.",
        "target_date": date_str,
        "total_hours": round(total_hours, 2),
        "missing_projects": list(set(missing_projects)),
        "items": preview_items,
        "requires_user_approval": True
    }

def sync_timesheet(date_str, tasks, user_confirmed=False, target="demo"):
    if not user_confirmed:
        return {
            "status": "BLOCKED",
            "error": "SECURITY BLOCK: Sync execution requires explicit user confirmation! Call preview_timesheet first, present the preview to the user, and pass user_confirmed=True only after the user says YES."
        }

    db, uid, secret, models = get_connection(target)
    target_clean = (target or "demo").lower().strip()
    target_label = get_target_label(target_clean)
    target_user_id, target_emp_id = resolve_timesheet_user_and_employee(db, uid, secret, models)

    projects_raw = models.execute_kw(db, uid, secret, 'project.project', 'search_read', [[]], {'fields': ['id', 'name']})
    project_map = {p['name']: p['id'] for p in projects_raw}

    logs = []
    created_count = 0
    skipped_count = 0

    for item in tasks:
        proj_name = item.get('project_name', '')
        task_name = item.get('task_name', '')
        desc = item.get('description', '')
        hours = float(item.get('hours', 0))
        req_person = item.get('requestor_person', '')
        req_dept = item.get('requestor_department', '')

        proj_id = project_map.get(proj_name)
        if not proj_id:
            logs.append(f"❌ Skipped: Project '{proj_name}' not found in Odoo.")
            continue

        req_person_id = get_requestor_person_id(db, uid, secret, models, req_person) if req_person else None
        req_dept_id = get_requestor_dept_id(db, uid, secret, models, req_dept) if req_dept else None

        existing_tasks = models.execute_kw(
            db, uid, secret, 'project.task', 'search_read',
            [[['project_id', '=', proj_id], ['name', '=', task_name]]],
            {'fields': ['id', 'name']}
        )

        if existing_tasks:
            task_id = existing_tasks[0]['id']
        else:
            task_vals = {'name': task_name, 'project_id': proj_id}
            if target_user_id:
                task_vals['user_ids'] = [(6, 0, [target_user_id])]
            if req_person_id:
                task_vals['requestor_person_id'] = req_person_id
            if req_dept_id:
                task_vals['requestor_department_override_id'] = req_dept_id

            task_id = models.execute_kw(
                db, uid, secret, 'project.task', 'create',
                [task_vals]
            )
            logs.append(f"✨ Created Task: '{task_name}' (ID: {task_id}) in Project '{proj_name}'")

        ts_domain = [['date', '=', date_str], ['project_id', '=', proj_id], ['task_id', '=', task_id]]
        if target_user_id:
            ts_domain.append(['user_id', '=', target_user_id])
        elif target_emp_id:
            ts_domain.append(['employee_id', '=', target_emp_id])

        existing_ts = models.execute_kw(
            db, uid, secret, 'account.analytic.line', 'search',
            [ts_domain]
        )

        if existing_ts:
            logs.append(f"⏭️ Skipped duplicate: Timesheet for task '{task_name}' already exists on {date_str}.")
            skipped_count += 1
            continue

        ts_vals = {
            'date': date_str,
            'name': desc,
            'unit_amount': hours,
            'project_id': proj_id,
            'task_id': task_id,
        }
        if target_user_id:
            ts_vals['user_id'] = target_user_id
        if target_emp_id:
            ts_vals['employee_id'] = target_emp_id

        new_ts_id = models.execute_kw(
            db, uid, secret, 'account.analytic.line', 'create',
            [ts_vals]
        )
        created_count += 1
        logs.append(f"✅ Logged: {hours}h on '{task_name}' (Timesheet ID: {new_ts_id})")

    return {
        "status": "SYNC_COMPLETE",
        "target": target_label,
        "target_date": date_str,
        "created_count": created_count,
        "skipped_count": skipped_count,
        "logs": logs
    }

def cli_upgrade_module(target, modules, restart=True, user_confirmed=False):
    import subprocess
    import time
    import urllib.request
    import re

    if isinstance(modules, list):
        modules = ",".join(modules)
    clean_modules = ",".join([m.strip() for m in str(modules).split(",") if m.strip()])
    if not clean_modules or not re.match(r'^[a-zA-Z0-9_,-]+$', clean_modules):
        raise ValueError(f"Invalid module names format: {modules}")

    target_clean = (target or "demo").lower().strip()
    env_file = get_env_path(target_clean)
    if os.path.exists(env_file):
        load_dotenv(env_file, override=True)

    if target_clean in ("prod", "crm"):
        if not user_confirmed:
            raise PermissionError("CLI Upgrade ke Production membutuhkan konfirmasi eksplisit dari pengguna. Wajib sertakan user_confirmed=true.")

    ssh_host = os.getenv("ODOO_SSH_HOST")
    ssh_user = os.getenv("ODOO_SSH_USER")
    ssh_pass = os.getenv("ODOO_SSH_PASS")
    if not ssh_host or not ssh_user or not ssh_pass:
        raise PermissionError(f"Missing ODOO_SSH_HOST, ODOO_SSH_USER, or ODOO_SSH_PASS in {env_file} for target '{target_clean}'")

    db = os.getenv("ODOO_ADMIN_DB") or os.getenv("ODOO_DB", target_clean)
    odoo_url = os.getenv("ODOO_ADMIN_URL") or os.getenv("ODOO_URL", "")
    health_url = os.getenv("ODOO_HEALTH_URL") or (f"{odoo_url}/web/health" if odoo_url else "")

    is_swarm = os.getenv("ODOO_IS_SWARM", "").lower() in ("true", "1", "yes") or target_clean in ("prod", "crm")
    if is_swarm:
        swarm_service = os.getenv("ODOO_SWARM_SERVICE", "odoo_service")
        container_pattern = os.getenv("ODOO_CONTAINER_PATTERN", f"{swarm_service}.1")
        cli_cmd = (
            f"CID=$(docker ps -q -f name={container_pattern} | head -n 1); "
            f"if [ -z \"$CID\" ]; then echo 'Container matching {container_pattern} not found' >&2; exit 1; fi; "
            f"docker exec -t $CID odoo -c /etc/odoo/odoo.conf -d {db} -u {clean_modules} --stop-after-init --no-http"
        )
        restart_cmd = os.getenv("ODOO_RESTART_CMD", f"docker service update --force {swarm_service}")
    else:
        container_name = os.getenv("ODOO_CONTAINER", "odoo18")
        db_host = os.getenv("ODOO_DB_HOST", "postgres")
        db_port = os.getenv("ODOO_DB_PORT", "5432")
        db_user = os.getenv("ODOO_DB_USER", "odoo")
        db_pass = os.getenv("ODOO_DB_PASSWORD")
        db_pass_arg = f" --db_password={db_pass}" if db_pass else ""
        cli_cmd = (
            f"docker exec -t {container_name} odoo -c /etc/odoo/odoo.conf "
            f"--db_host={db_host} --db_port={db_port} --db_user={db_user}{db_pass_arg} "
            f"-d {db} -u {clean_modules} --stop-after-init --no-http"
        )
        restart_cmd = os.getenv("ODOO_RESTART_CMD", f"docker restart {container_name}")

    # Step 1: Run CLI Upgrade
    res_cli = subprocess.run(
        ["sshpass", "-p", ssh_pass, "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", f"{ssh_user}@{ssh_host}", cli_cmd],
        capture_output=True, text=True, timeout=180
    )
    if res_cli.returncode != 0:
        err_msg = res_cli.stderr.strip() or res_cli.stdout.strip()
        raise RuntimeError(f"Odoo CLI upgrade failed on {ssh_host}: {err_msg}")
    cli_output = res_cli.stdout.strip()

    # Step 2: Restart container if requested
    restart_summary = "Skipped"
    if restart:
        res_restart = subprocess.run(
            ["sshpass", "-p", ssh_pass, "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", f"{ssh_user}@{ssh_host}", restart_cmd],
            capture_output=True, text=True, timeout=60
        )
        if res_restart.returncode != 0:
            err_msg = res_restart.stderr.strip() or res_restart.stdout.strip()
            raise RuntimeError(f"Restart container failed on {ssh_host}: {err_msg}")
        restart_summary = res_restart.stdout.strip().splitlines()[-1] if res_restart.stdout.strip() else "Restarted"
        time.sleep(3)

    # Step 3: Health check
    health_status = "UNKNOWN"
    if health_url:
        try:
            req = urllib.request.Request(health_url, headers={"User-Agent": "Pi-Agent-Deployer"})
            with urllib.request.urlopen(req, timeout=5) as r:
                health_status = f"HTTP {r.status} OK"
        except Exception as e:
            health_status = f"Health check warning: {str(e)}"

    return {
        "status": "CLI_UPGRADE_SUCCESS",
        "target": target,
        "database": db,
        "modules": clean_modules,
        "host": ssh_host,
        "restart_summary": restart_summary,
        "health_check": health_status,
        "cli_log_tail": "\n".join(cli_output.splitlines()[-10:]) if cli_output else "",
    }

def deploy_module(target, module_name, user_confirmed=False):
    import subprocess
    import time
    import urllib.request
    import urllib.parse
    
    # Load GitLab Token
    env_gitlab = os.path.join(SCRIPT_DIR, ".env_gitlab")
    if os.path.exists(env_gitlab):
        load_dotenv(env_gitlab, override=True)
    gitlab_token = os.getenv("GITLAB_PERSONAL_ACCESS_TOKEN")
    if not gitlab_token:
        raise PermissionError(f"Missing GITLAB_PERSONAL_ACCESS_TOKEN in {env_gitlab} or environment")

    target_clean = (target or "demo").lower().strip()
    env_file = get_env_path(target_clean)
    if os.path.exists(env_file):
        load_dotenv(env_file, override=True)

    if target_clean in ("prod", "crm"):
        if not user_confirmed:
            raise PermissionError("Deployment ke Production membutuhkan konfirmasi eksplisit dari pengguna. Wajib sertakan user_confirmed=true setelah rencana disetujui.")

    ssh_host = os.getenv("ODOO_SSH_HOST")
    ssh_user = os.getenv("ODOO_SSH_USER")
    ssh_pass = os.getenv("ODOO_SSH_PASS")
    if not ssh_host or not ssh_user or not ssh_pass:
        raise PermissionError(f"Missing ODOO_SSH_HOST, ODOO_SSH_USER, or ODOO_SSH_PASS in {env_file} for target '{target_clean}'")

    addons_base = os.getenv("ODOO_ADDONS_PATH")
    if not addons_base:
        raise ValueError(f"Missing ODOO_ADDONS_PATH in {env_file} for target '{target_clean}'")
    addon_dir = f"{addons_base}/{module_name}"

    is_swarm = os.getenv("ODOO_IS_SWARM", "").lower() in ("true", "1", "yes") or target_clean in ("prod", "crm")
    if is_swarm:
        swarm_service = os.getenv("ODOO_SWARM_SERVICE", "odoo_service")
        restart_cmd = os.getenv("ODOO_RESTART_CMD", f"docker service update --force {swarm_service}")
    else:
        container_name = os.getenv("ODOO_CONTAINER", "odoo18")
        restart_cmd = os.getenv("ODOO_RESTART_CMD", f"docker restart {container_name}")

    odoo_url = os.getenv("ODOO_ADMIN_URL") or os.getenv("ODOO_URL", "")
    health_url = os.getenv("ODOO_HEALTH_URL") or (f"{odoo_url}/web/health" if odoo_url else "")

    # Resolve git repo URL template
    gitlab_api_url = os.getenv("GITLAB_API_URL", "")
    gitlab_host = urllib.parse.urlparse(gitlab_api_url).netloc if gitlab_api_url else os.getenv("GITLAB_HOST", "")
    gitlab_group = os.getenv("GITLAB_PROJECT_GROUP", "odoo-addons")
    git_repo_url = os.getenv("ODOO_GIT_REPO_URL") or f"https://oauth2:{gitlab_token}@{gitlab_host}/{gitlab_group}/{module_name}.git"

    # Step 1: Git Pull / Clone via token on host server
    pull_cmd = (
        f"if [ -d '{addon_dir}' ]; then "
        f"cd '{addon_dir}' && git pull {git_repo_url} main; "
        f"else "
        f"git clone {git_repo_url} '{addon_dir}'; "
        f"fi && cd '{addon_dir}' && git log -n 1 --oneline"
    )
    res_pull = subprocess.run(
        ["sshpass", "-p", ssh_pass, "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", f"{ssh_user}@{ssh_host}", pull_cmd],
        capture_output=True, text=True, timeout=45
    )
    if res_pull.returncode != 0:
        err_msg = res_pull.stderr.strip() or res_pull.stdout.strip()
        raise RuntimeError(f"Git pull/clone failed on {ssh_host}: {err_msg}")
    git_output = res_pull.stdout.strip()

    # Step 2: Restart container / service
    res_restart = subprocess.run(
        ["sshpass", "-p", ssh_pass, "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5", f"{ssh_user}@{ssh_host}", restart_cmd],
        capture_output=True, text=True, timeout=60
    )
    if res_restart.returncode != 0:
        err_msg = res_restart.stderr.strip() or res_restart.stdout.strip()
        raise RuntimeError(f"Restart container failed on {ssh_host}: {err_msg}")
    restart_output = res_restart.stdout.strip()

    # Wait for service to be healthy (retry up to 45s)
    service_ready = False
    if health_url:
        for attempt in range(15):
            time.sleep(3)
            try:
                req = urllib.request.Request(health_url, headers={"User-Agent": "Pi-Agent-Deployer"})
                with urllib.request.urlopen(req, timeout=3) as r:
                    if r.status == 200:
                        service_ready = True
                        break
            except Exception:
                pass

    if not service_ready and health_url:
        time.sleep(5)

    # Step 3: Upgrade / Install module in database via XML-RPC (with automatic Docker CLI fallback)
    upgrade_method = "XML-RPC"
    action_name = "UPGRADED"
    mod_id = None
    try:
        db, uid, secret, models = get_connection(target)
        mod_data = models.execute_kw(db, uid, secret, "ir.module.module", "search_read", [[["name", "=", module_name]]], {"fields": ["id", "state"]})
        if not mod_data:
            models.execute_kw(db, uid, secret, "ir.module.module", "update_list", [])
            mod_data = models.execute_kw(db, uid, secret, "ir.module.module", "search_read", [[["name", "=", module_name]]], {"fields": ["id", "state"]})
            if not mod_data:
                raise ValueError(f"Module '{module_name}' not found on target '{target}' ({db})")

        mod_record = mod_data[0]
        mod_id = mod_record["id"]
        current_state = mod_record.get("state")

        if current_state == "installed":
            models.execute_kw(db, uid, secret, "ir.module.module", "button_immediate_upgrade", [[mod_id]])
            action_name = "UPGRADED"
        else:
            models.execute_kw(db, uid, secret, "ir.module.module", "button_immediate_install", [[mod_id]])
            action_name = "INSTALLED"
    except Exception as rpc_err:
        # Fallback to direct Docker CLI upgrade (immune to 500 error / missing columns / dependency deadlocks)
        cli_res = cli_upgrade_module(target, module_name, restart=True, user_confirmed=user_confirmed)
        upgrade_method = f"Docker CLI Fallback (XML-RPC error: {str(rpc_err)[:100]})"
        action_name = "UPGRADED (CLI)"

    # Step 4: Health check
    health_status = "UNKNOWN"
    try:
        req = urllib.request.Request(health_url, headers={"User-Agent": "Pi-Agent-Deployer"})
        with urllib.request.urlopen(req, timeout=5) as r:
            health_status = f"HTTP {r.status} OK"
    except Exception as e:
        health_status = f"Health check warning: {str(e)}"

    return {
        "status": "DEPLOY_SUCCESS",
        "target": target,
        "module": module_name,
        "module_id": mod_id,
        "upgrade_method": upgrade_method,
        "action": action_name,
        "host": ssh_host,
        "git_output": git_output,
        "restart_summary": restart_output.splitlines()[-1] if restart_output else "Restarted",
        "health_check": health_status,
    }

def run_action(action, payload):
    target = payload.get("target", "demo")
    
    # Timesheet operations
    if action == "list_projects":
        name_filter = payload.get("name_filter", "")
        return list_projects(target=target, name_filter=name_filter)
        
    elif action == "preview_timesheet":
        date_str = payload.get("date_str", "")
        tasks = payload.get("tasks", [])
        return preview_timesheet(date_str, tasks, target=target)
        
    elif action == "sync_timesheet":
        date_str = payload.get("date_str", "")
        tasks = payload.get("tasks", [])
        user_confirmed = payload.get("user_confirmed", False)
        return sync_timesheet(date_str, tasks, user_confirmed, target=target)
        
    # Admin / ORM operations
    elif action == "search_read":
        db, uid, secret, models = get_connection(target)
        model = payload["model"]
        domain = payload.get("domain", [])
        fields = payload.get("fields")
        limit = payload.get("limit", 50)
        offset = payload.get("offset", 0)
        opts = {"limit": limit, "offset": offset}
        if fields:
            opts["fields"] = fields
        res = models.execute_kw(db, uid, secret, model, "search_read", [domain], opts)
        return mask_sensitive_records(res)
        
    elif action == "read":
        db, uid, secret, models = get_connection(target)
        model = payload["model"]
        ids = payload["ids"]
        fields = payload.get("fields")
        opts = {}
        if fields:
            opts["fields"] = fields
        res = models.execute_kw(db, uid, secret, model, "read", [ids], opts)
        return mask_sensitive_records(res)
        
    elif action == "search_count":
        db, uid, secret, models = get_connection(target)
        model = payload["model"]
        domain = payload.get("domain", [])
        return models.execute_kw(db, uid, secret, model, "search_count", [domain])

    elif action == "fields_get":
        db, uid, secret, models = get_connection(target)
        model = payload["model"]
        fields = payload.get("fields")
        attributes = payload.get("attributes", [
            "type", "string", "help", "required", "readonly", "selection", "relation", "store"
        ])
        args = [fields] if fields else []
        opts = {"attributes": attributes} if attributes else {}
        return models.execute_kw(db, uid, secret, model, "fields_get", args, opts)
        
    elif action == "upgrade_module":
        db, uid, secret, models = get_connection(target)
        module_name = payload["module_name"]
        mod_ids = models.execute_kw(db, uid, secret, "ir.module.module", "search", [[["name", "=", module_name]]])
        if not mod_ids:
            raise ValueError(f"Module '{module_name}' not found on target '{target}' ({db})")
        models.execute_kw(db, uid, secret, "ir.module.module", "button_immediate_upgrade", [mod_ids])
        return {
            "status": "UPGRADE_SUCCESS",
            "module": module_name,
            "module_id": mod_ids[0],
            "target": target,
            "database": db,
        }

    elif action == "deploy_module":
        module_name = payload["module_name"]
        user_confirmed = payload.get("user_confirmed", False)
        return deploy_module(target, module_name, user_confirmed)

    elif action == "cli_upgrade_module":
        modules = payload["modules"]
        restart = payload.get("restart", True)
        user_confirmed = payload.get("user_confirmed", False)
        return cli_upgrade_module(target, modules, restart=restart, user_confirmed=user_confirmed)
        
    else:
        raise ValueError(f"Unknown action: {action}")

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"success": False, "error": "Usage: odoo_runner.py <action> <json_payload>"}))
        sys.exit(1)
        
    action = sys.argv[1]
    try:
        payload = json.loads(sys.argv[2])
        res = run_action(action, payload)
        print(json.dumps({"success": True, "data": res}, default=str))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()

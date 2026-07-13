# ManeBid — Convention Auction Manager

## Deployment Guide

This guide explains how to deploy the ManeBid backend and frontend using Node.js, Apache, PM2, and Let's Encrypt for free HTTPS certificates. It assumes an Ubuntu command style (developed on Mint and Ubuntu).

The default locations are:

    Backend:                /opt/manebid/
    Database:               /var/lib/manebid/manebid.db
    Data:                   /var/lib/manebid
    Uploaded resources:     /var/lib/manebid/resources
    Auction item pictures:  /var/lib/manebid/uploads
    Database backups:       /var/lib/manebid/backup
    Generated outputs:      /var/lib/manebid/output
    Secure environment:     /etc/manebid/manebid.env
    Logs:                   /var/log/manebid/manebid.log
    Frontend:               /var/www/manebid-frontend

If your installation requires different paths, remember to update `config.json` accordingly and adapt the instructions.

---

## **System Requirements**

* Linux server
* Root/sudo access 
* A registered domain name (e.g. `yourdomain.com`) pointing to your server's IP address

---

## **Install Node.js**

The backend requires Node.js 20 or newer. The `nodejs` package in the default Ubuntu repositories may not be recent, so install Node from the NodeSource LTS repository instead:

    sudo apt update
    sudo apt install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs

Verify:

    node -v
    npm -v

The `node -v` output should show `v20.x` or newer. If it still shows an older version, remove the older package and reinstall:

    sudo apt remove nodejs
    sudo apt install -y nodejs

---

## **Automated backend installer**

The repository includes an interactive backend installer:

```bash
./backend/install-backend.sh
```

The installer automates the backend parts of this guide only. It does not install or configure the frontend, Apache, HTTPS certificates, or DNS.

The installer will:

* Offer the default backend, data, database, backup, upload, output, secure env, and log directories shown above, and allow you to change them.
* Copy the backend into the selected backend directory.
* Install backend Node dependencies.
* Generate `manebid.env` from `manebid.env.example`, either using a securely generated `SECRET_KEY` or one you enter.
* Update the deployed `config.json`, default PowerPoint/card config resource paths, and generated process files to match the selected directories.
* Ask whether to use systemd service operation or PM2 operation.
* Detect an existing installation and ask whether to overwrite or stop.
* Check separately for an existing database and offer to back it up before continuing.
* Run the backend once on a new database and report the initial root password, which is only shown once by the backend.
* Print a summary of useful paths, config values, and any privileged commands that still need to be run.

To inspect what it would do without changing files:

```bash
./backend/install-backend.sh --dry-run
```

If you run the installer as root, it can create the `manebid` service user, create protected directories, set permissions, install the systemd unit, and start the service. If you run it as a normal user, it will do everything it can using your account and then print the `sudo` commands required to complete privileged steps. This is the preferred approach if you want to inspect privileged actions before running them.

After installation, review non-secret settings and secrets with:

```bash
nano /opt/manebid/config.json
nano /etc/manebid/manebid.env
```

Use your selected paths instead of `/opt/manebid` and `/etc/manebid` if you changed them during installation. Restart the backend after changing either file.

---


## Create a dedicated service user

```
sudo useradd --system --home /opt/manebid --shell /usr/sbin/nologin manebid
```

## Create directories

```
sudo mkdir -p /opt/manebid /var/lib/manebid /var/log/manebid /etc/manebid /var/www/manebid-frontend

# Data subfolders
sudo mkdir -p /var/lib/manebid/resources /var/lib/manebid/backup /var/lib/manebid/uploads /var/lib/manebid/output

```



## Ownership & permissions:

```
sudo chown -R manebid:manebid /opt/manebid /var/lib/manebid /var/log/manebid
sudo chmod 750 /opt/manebid /var/lib/manebid /var/log/manebid
sudo chmod 750 /etc/manebid
```

## **Setup Your Project Directory and install dependencies**

Clone or copy the repository to a convenient folder on the server

    git clone https://github.com/coastie-uk/convention-auction 

Copy the backend and frontend to the required folder

    sudo rsync -a [path to the repo]/convention-auction/backend/ /opt/manebid/
    sudo rsync -a [path to the repo]/convention-auction/public/ /var/www/manebid-frontend


Navigate to the folder:

    cd /opt/manebid/

Install Node dependencies:

    npm install

Set ownership of the backend and frontend files

    sudo chown -R manebid:manebid /opt/manebid
    sudo chown -R www-data:www-data /var/www/manebid-frontend

---

## Create the env file

Copy manebid.env.example to /etc/manebid/manebid.env and update the contents
At minimum, you must set the SECRET_KEY and enable the required payment methods
When done, set restrictive permissions (`0640`, owned by `root:manebid`).

```
# Quick way to generate a suitable SECRET_KEY value (or use your own)
openssl rand -base64 48

# Create manebid.env and edit as required
sudo cp manebid.env.example /etc/manebid/manebid.env
sudo nano /etc/manebid/manebid.env

# Set permissions - IMPORTANT!
sudo chown root:manebid /etc/manebid/manebid.env
sudo chmod 640 /etc/manebid/manebid.env
```

## **Configure backend config.json**

`backend/config.json` contains the non-secret runtime settings for the backend. Secrets (like `SECRET_KEY`) must live in `/etc/manebid/manebid.env`, not in `config.json`. The backend validates the config on startup and will exit if required values are missing or out of range.

The defaults should suffice for most use cases, but you may want to adjust based on your server configuration / capabilities.

Below is a description of each setting:

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `PORT` | number | `3000` | Port for the HTTP server. Range: **1–65535**. |
| `HOST` | text | `"127.0.0.1"` | Bind address. Keep loopback when Apache is the only intended API entry point. |
| `TRUSTED_PROXIES` | list | `["loopback", "192.168.0.254/32"]` | Exact Express proxy trust chain. Replace the second address if your nginx/edge proxy differs; never use blanket `true`. |
| `CONFIG_IMG_DIR` | text | `"/var/lib/manebid/resources"` | Directory for config images/resources. Must be a non-empty string. |
| `BACKUP_DIR` | text | `"/var/lib/manebid/backup"` | Directory for DB backups. Must be a non-empty string. |
| `UPLOAD_DIR` | text | `"/var/lib/manebid/uploads"` | Directory for uploaded item images. Must be a non-empty string. |
| `PPTX_CONFIG_DIR` | text | `"/var/lib/manebid"` | Directory for PPTX config files. Must be a non-empty string. |
| `OUTPUT_DIR` | text | `"/var/lib/manebid/output"` | Directory for generated outputs. Must be a non-empty string. |
| `DB_PATH` | text | `"/var/lib/manebid"` | Directory where the database file lives. Must be a non-empty string. |
| `DB_NAME` | text | `"manebid.db"` | Database filename. Length **1–100** characters. |
| `LOG_DIR` | text | `"/var/log/manebid"` | Directory for log files. Must be a non-empty string. |
| `LOG_NAME` | text | `"manebid.log"` | Log filename. Must be a non-empty string. |
| `SAMPLE_DIR` | text | `"sample-assets"` | Directory for sample assets. Must be a non-empty string. |
| `MAX_UPLOADS` | number | `100` | Max config images allowed. Range: **1–1000**. |
| `allowedExtensions` | list | `[".jpg", ".jpeg", ".png"]` | Allowed upload file extensions. Each entry should be a non-empty string. |
| `LOG_LEVEL` | text | `"INFO"` | Logging level (e.g., `DEBUG`, `INFO`, `WARN`, `ERROR`). Length **3–10** characters. |
| `MAX_AUCTIONS` | number | `100` | Max auctions allowed in the system. Range: **1–100**. |
| `MAX_ITEMS` | number | `2000` | Max items across auctions. Range: **1–10000**. |
| `ITEM_PHOTO_MAX_MB` | number | `10` | Maximum item photo upload size in megabytes. Range: **1–50**. |
| `RESOURCE_IMAGE_MAX_MB` | number | `10` | Maximum size of one maintenance resource image in megabytes. Range: **1–50**. |
| `RESOURCE_UPLOAD_MAX_FILES` | number | `50` | Maximum resource images accepted in one request. Range: **1–MAX_UPLOADS**. |
| `BACKUP_UPLOAD_MAX_MB` | number | `512` | Maximum compressed managed-backup upload and archive size in megabytes. Range: **1–16384**. |
| `BACKUP_ARCHIVE_MAX_EXPANDED_MB` | number | `2048` | Maximum cumulative expanded size while inspecting or restoring a backup in megabytes. Range: **1–65536**. |
| `BACKUP_ARCHIVE_MAX_ENTRY_MB` | number | `512` | Maximum expanded size of one backup entry in megabytes. Range: **1–BACKUP_ARCHIVE_MAX_EXPANDED_MB**. |
| `BACKUP_ARCHIVE_MAX_ENTRIES` | number | `10000` | Maximum number of ZIP entries, including directories. Range: **1–100000**. |
| `CURRENCY_SYMBOL` | text | `"£"` | Currency symbol for display. Length **1–3** characters. |
| `PASSWORD_MIN_LENGTH` | number | `8` | Minimum password length. Range: **5–100**. |
| `RATE_LIMIT_WINDOW` | number | `60` | Public item submission rate limit window in seconds. Range: **1–86400**. |
| `RATE_LIMIT_MAX` | number | `10` | Public item submission max requests per rate limit window. Range: **1–1000**. |
| `LOGIN_LOCKOUT_AFTER` | number | `8` | Failed login attempts before lockout. Range: **1–1000**. |
| `LOGIN_IP_LOCKOUT_AFTER` | number | `40` | Failed login attempts allowed across all usernames from one client IP during `LOGIN_LOCKOUT`. Range: **1–10000**. |
| `LOGIN_LOCKOUT` | number | `600` | Lockout duration in seconds. Range: **1–86400**. |
| `SERVICE_NAME` | text | `"manebid-backend"` | Service name used in logs/process metadata. Length **1–100** characters. |
| `MESSAGING_ENABLED` | boolean | `true` | Enable operator messaging on management pages. |
| `MESSAGING_MAX_MESSAGES` | number | `1000` | Maximum number of operator messages kept in the backend message cache. Range: **1–100000**. |
| `MESSAGING_MAX_CACHE_BYTES` | number | `5000000` | Maximum estimated bytes kept in the backend message cache. Range: **1024–52428800**. |
| `MESSAGING_MAX_MESSAGE_CHARS` | number | `500` | Maximum length of one operator message in characters. Range: **1–5000**. |
| `MESSAGING_OPEN_POLL_MS` | number | `3000` | Poll interval in milliseconds while the operator messaging modal is open. Range: **1000–60000**. |
| `MESSAGING_PRESENCE_TTL_MS` | number | `90000` | How long in milliseconds a recent messaging poll counts a user as online. Range: **5000–3600000**. |
| `MESSAGING_PERSISTENCE_FILE` | text | `"/var/lib/manebid/operator-messages.json"` | File used to persist operator message history across backend restarts. Defaults to `operator-messages.json` in `DB_PATH` if omitted. |
| `ENABLE_CORS` | boolean | `false` | Enable CORS handling. |
| `ALLOWED_ORIGINS` | list | `["localhost:3000", "example.com:3000"]` | Allowed origins when CORS is enabled. Each entry is trimmed; empty strings are ignored. |

### Backend binding and trusted proxies

`HOST` controls which local network interfaces accept connections to the Node
backend. It is separate from the public hostname used in a browser.

For the normal installation, Apache and Node run on the same server:

```json
{
  "HOST": "127.0.0.1",
  "PORT": 3000,
  "TRUSTED_PROXIES": ["loopback"]
}
```

`127.0.0.1` prevents other machines from connecting directly to Node. Public
traffic must pass through Apache, which applies TLS and the configured security
headers. This is the recommended arrangement.

Only change `HOST` when the reverse proxy genuinely runs on another host or in
another network namespace. In that case, bind Node to the specific private
interface that the proxy uses and restrict the port with a firewall. Avoid
`"0.0.0.0"` unless listening on every interface is required and direct public
access to the backend port is blocked.

`TRUSTED_PROXIES` tells Express which reverse-proxy hops may supply client
address information through `X-Forwarded-For`. This is important because public
submission throttling, username/IP login throttling, IP-wide login throttling,
and request logs all use the resulting client IP.

The list must contain only the proxy addresses between the backend and the
client. Express evaluates the chain from the backend outwards and uses the
first address that is not trusted as the client address.

Common configurations:

Apache on the same host, directly facing clients:

```json
"TRUSTED_PROXIES": ["loopback"]
```

Local Apache behind an nginx proxy at exactly `192.168.0.254`:

```json
"TRUSTED_PROXIES": ["loopback", "192.168.0.254/32"]
```

Replace `192.168.0.254/32` with the exact address or CIDR of your real proxy.
Do not copy that address to an installation with a different network layout.
Do not configure Express to trust every proxy (`true`) or trust an unnecessarily
broad client network: an attacker could forge `X-Forwarded-For`, evade rate
limits, or place another user's address in the logs.

The internet-facing proxy must overwrite or sanitize incoming forwarded
headers. For example, an nginx edge proxy with no trusted proxy in front of it
should set `X-Forwarded-For` from its actual connection source rather than
accepting an arbitrary value supplied by the client.

After changing either setting, restart the backend and confirm that:

- the service listens only on the intended address;
- requests still reach `/api/` through Apache;
- logs show the real client address rather than the proxy address; and
- two different client addresses receive separate rate-limit quotas.

### Upload limits at Apache and nginx

The backend always enforces the resource and backup limits above. The tracked
`deploy/apache-manebid-security.conf` also applies `LimitRequestBody` to the two
maintenance upload routes using the documented defaults plus multipart
overhead. If you change the backend limits, update that fragment and reload
Apache so the values remain aligned.

If nginx is the internet-facing proxy, configure an equivalent
`client_max_body_size` for `/api/maintenance/backups/import/inspect` and
`/api/maintenance/resources/upload`. The nginx limit must include multipart
overhead and must not be lower than the intended backend limit. The backend
remains the authoritative control.

If you make changes once the server is running, remember to restart the service to pick up changes:

```bash
sudo systemctl restart manebid-backend
```

## **Start the server**

From within /opt/manebid/ confirm that the backend starts

    node backend.js

You should see a number of log entries similar to those shown below. Any errors should be investigated before proceeding. Most likely culprits are paths and permissions

```
[WARN] [unknown] [General] Database file not found; creating new database at /var/lib/manebid/manebid.db
[WARN] [unknown] [General] Schema version missing or mismatched (db=missing, expected=3.1); Running DB setup
[WARN] [unknown] [General] Created default root account with full permissions.
[WARN] [unknown] [General] Initial root password (shown once): [Random password]
[INFO] [unknown] [General] Database opened
[INFO] [unknown] [General] ~~ Starting up Auction backend ~~
[INFO] [unknown] [Logger] Logging framework initialized.
[INFO] [unknown] [General] Backend version: 3.1.0, DB schema version: 3.1
[INFO] [unknown] [General] Payment processor: SumUp 1.3.0(2026-07-05)
[INFO] [unknown] [Logger] Log level set to DEBUG
[INFO] [unknown] [General] CORS is disabled.
[INFO] [unknown] [General] Server startup complete and listening on 127.0.0.1:3000
```

On first run the backend will:
    Create the database
    Create a logfile
    Create a root user and set the initial password
    Generate default pptx config files
    Copy default image resource files into the required folder

Note the root password (it won't be shown again). Ctrl-C to terminate the backend process, and continue setting up.

## Create the systemd service

Copy the provided manebid-backend.service file to `/etc/systemd/system/manebid-backend.service`:

```bash
sudo cp manebid-backend.service /etc/systemd/system/manebid-backend.service
```

If you've adjusted any of the default paths, remember to update the following lines to match:

    WorkingDirectory=/opt/manebid
    EnvironmentFile=/etc/manebid/manebid.env
    ExecStart=/usr/bin/node /opt/manebid/backend.js
    ReadWritePaths=/var/lib/manebid /var/log/manebid
    ReadOnlyPaths=/opt/manebid
 

### 5) Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now manebid-backend
sudo systemctl status manebid-backend
```

### 6) Verify

```bash
sudo journalctl -u manebid-backend -f
```
---



## **Install and Configure Apache**

Install Apache:

    sudo apt install apache2

Enable required modules:

    sudo a2enmod ssl proxy proxy_http proxy_wstunnel headers rewrite
    sudo systemctl reload apache2

Create a virtual host file:

    sudo nano /etc/apache2/sites-available/manebid.conf

Paste and edit the config to include your domain name. If you already have SSL keys, uncomment those lines and point them to the required files.

```
<VirtualHost *:80>
    ServerName yourdomain.com
    Redirect permanent / https://yourdomain.com/
</VirtualHost>

<VirtualHost *:443>
    ServerName yourdomain.com

#   If you have your own certificates, insert them here. Otherwise leave as-is and let CertBot update the file
#   SSLEngine on
#   SSLCertificateFile /etc/letsencrypt/live/yourdomain.com/fullchain.pem
#   SSLCertificateKeyFile /etc/letsencrypt/live/yourdomain.com/privkey.pem

    DocumentRoot /var/www/manebid-frontend

    <Directory /var/www/manebid-frontend>
        Options Indexes FollowSymLinks
        AllowOverride None
        Require all granted
    </Directory>

    ProxyPreserveHost On
    ProxyPass /api/ http://127.0.0.1:3000/
    ProxyPassReverse /api/ http://127.0.0.1:3000/

    # SumUp webhook for web payments - Note the placement of trailing '/'
    ProxyPass /payments/sumup/webhook http://localhost:3000/payments/sumup/webhook/
    ProxyPassReverse /payments/sumup/webhook http://localhost:3000/payments/sumup/webhook/

    # SumUp webhook for app payments - Note the placement of trailing '/'
    ProxyPass /payments/sumup/callback/ http://localhost:3000/payments/sumup/callback/
    ProxyPassReverse /payments/sumup/callback/ http://localhost:3000/payments/sumup/callback/

    ErrorLog ${APACHE_LOG_DIR}/manebid-error.log
    CustomLog ${APACHE_LOG_DIR}/manebid-access.log combined
</VirtualHost>
```

Enable the site:

    sudo a2ensite manebid.conf
    sudo systemctl restart apache2

Install the tracked CSP and security-header policy, then validate Apache before
reloading it:

```
sudo install -m 0644 deploy/apache-manebid-security.conf /etc/apache2/conf-available/manebid-security.conf
sudo a2enconf manebid-security
sudo apache2ctl configtest
sudo systemctl reload apache2
```

The backend service must run with `NODE_ENV=production` so the session cookie
receives the `Secure` attribute. All existing operator sessions end when this
authentication change is deployed.

---

## **Install HTTPS via Let's Encrypt with CertBot**

Install Certbot:

    sudo apt install certbot python3-certbot-apache

Generate and install a free certificate:

    sudo certbot --apache -d yourdomain.com

When prompted, choose to redirect all HTTP to HTTPS.

Test automatic renewal:

    sudo certbot renew --dry-run

Restart Apache if changes don’t take effect:  
    sudo systemctl restart apache2

To test your installation, go to [Your URL]/maint. Login as "root" and the initial password you noted earlier. The "security" tab can be used to create additional users as required. 

For further instructions, see quickstart.md

For instructions for setting up SumUp, see sumup_setup.md

---

The default setup assumes that frontend and backend are running on the same server- /api/ is proxied to the backend on localhost, port 3000\. If this is not the case, changes may be needed depending on your configuration and how the connections are proxied.

* If a port other than 3000 is needed, edit the port setting in config.json.
* Update the Apache site .conf file as required to relay the traffic to the target server
* CORS may be needed to prevent browsers blocking the cross-domain traffic. The backend has been built with CORS middleware - Set ENABLE_CORS = true and populate ALLOWED_ORIGINS with the required addresses.

## Server Management (CLI-only)

`node server-management.js` is a self-contained node CLI tool which exposes maintenance tasks that are intentionally not available in the web UI. Run it from the server to perform:

- Reset passwords
- Remove all users (apart from the root user)
- Remove test-generated users with `pt_`, `mt_`, or `bt_` username prefixes after reviewing the matched list
- Clear the audit log
- Reset the database (clears bidders, auctions, items, payments, and payment intents). Item counters are not reset to maintain alignment with the audit log
- Reset the database **and** counters (effectively results in a new database, but with the existing users)


## **Setup PM2 to Run the Backend**

Note: For security reasons it is recommended to run the backend as a service. These PM2 instructions have been retained for test/legacy purposes.

PM2 provides a convenient method to manage the backend and also allows the maintenance GUI to restart the server.

Install PM2 globally:

    sudo npm install -g pm2

Start and name your app:

    pm2 start backend.js --name manebid

Save the PM2 process list:

    pm2 save

Enable startup on boot:

    pm2 startup  
\# Follow the printed instructions to enable startup

To view console output:

    pm2 logs manebid

To remove a site:

    pm2 stop manebid
    pm2 delete manebid
    pm2 save

---

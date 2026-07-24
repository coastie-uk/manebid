# ManeBid Docker deployment

Docker is an alternative deployment mode for ManeBid. It lives in the same
repository as the standalone Node.js/Apache installation; neither deployment
mode requires a fork.

The Compose application contains two services:

- `web`: Caddy serves the static frontend, applies the production security
  headers, and proxies API and SumUp callback traffic. It obtains and renews
  TLS certificates when it is the internet-facing web server; an upstream
  reverse proxy can terminate TLS instead.
- `backend`: the Node.js/Express application and SQLite database. Its port is
  available only on the private Compose network.

Application data is held in the `manebid_data` Docker volume. Caddy's
certificates and state are held in the `caddy_data` and `caddy_config` volumes.
Rebuilding or replacing the containers does not remove these volumes.

## Requirements

- Docker Engine with the Compose plugin (`docker compose version`)
- A user allowed to run Docker
- For a public deployment, a DNS name pointing either to this host or to the
  upstream reverse proxy that will serve it
- For a direct public Caddy deployment, inbound TCP ports 80 and 443 (plus UDP
  443 if HTTP/3 is wanted)
- Internet access for the initial image build and, when Caddy terminates TLS,
  certificate issuance; SumUp-enabled backends also need outbound HTTPS access

Anyone who can control the Docker daemon is effectively an administrator of
the host and can read container secrets and volumes. Limit membership of the
`docker` group accordingly.

## Install required host packages

The host needs Docker Engine, the Docker CLI, Buildx, the Docker Compose plugin,
`git`, and `openssl`. You do **not** need to install Node.js, npm, Caddy,
SQLite, Python, or native build tools on the host: the Docker build installs
those dependencies inside the appropriate image.

First check whether Docker and the Compose plugin are already available:

```bash
docker --version
docker compose version
```

If both commands work, continue to [Installation](#installation).

### Ubuntu and Ubuntu-based systems

The following commands install Docker from Docker's official `apt` repository,
rather than the older `docker.io` or standalone `docker-compose` packages from
the distribution repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Docker does not officially support every Ubuntu derivative, including Linux
Mint, although the Ubuntu repository commonly works. Check that the generated
suite in `/etc/apt/sources.list.d/docker.sources` matches the Ubuntu release on
which the derivative is based.

### Debian and Debian-based systems

For Debian, configure Docker's Debian signing key and repository:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl

sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

On a Debian derivative, replace `VERSION_CODENAME` with the matching Debian
release codename if the derivative reports its own codename. For other Linux
distributions, follow Docker's
[platform-specific Engine instructions](https://docs.docker.com/engine/install/)
and install the Compose plugin rather than the legacy standalone
`docker-compose` executable.

If the host already has `docker.io`, `docker-compose`, `podman-docker`, a
separately installed `containerd`, or `runc`, review Docker's
[conflicting-package instructions](https://docs.docker.com/engine/install/ubuntu/#uninstall-old-versions)
before installing Docker CE. Do not remove packages blindly on a host already
running containers.

### Start and verify Docker

Enable Docker at boot, start it now, and verify the installation:

```bash
sudo systemctl enable --now docker.service containerd.service
sudo docker run --rm hello-world
sudo docker compose version
```

To run the remaining deployment commands without `sudo`, add the deployment
user to the `docker` group:

```bash
getent group docker || sudo groupadd docker
sudo usermod -aG docker "$USER"
```

Log out and back in so the new group membership takes effect, then verify:

```bash
docker run --rm hello-world
docker compose version
```

Membership of the `docker` group grants root-equivalent control of the Docker
host. Add only trusted deployment administrators. See Docker's
[Linux post-installation guidance](https://docs.docker.com/engine/install/linux-postinstall/)
for details and rootless alternatives.

Docker-published ports can interact unexpectedly with `ufw` and `firewalld`.
Before production use, review Docker's
[firewall warning](https://docs.docker.com/engine/install/ubuntu/#firewall-limitations)
and ensure only the intended public ports are allowed.

## Installation

From the repository root:

```bash
cd deploy/docker
cp .env.example .env
cp ../../backend/manebid.env.example manebid.env
chmod 600 manebid.env
```

Generate a random application secret:

```bash
openssl rand -base64 48
```

Edit `manebid.env`, paste that value after `SECRET_KEY=`, and configure the
payment methods. For a first local test, leave both SumUp methods disabled. For
a public deployment using SumUp, set the values described in
[SumUp and secret handling](#sumup-and-secret-handling) before starting the
containers.

The file must remain on the Docker host, be restricted to the deployment
administrator (`chmod 600`), and never be committed.

Next, edit `.env` for the intended deployment:

- For a local installation, leave `MANEBID_SITE_ADDRESS=localhost`. Change
  `MANEBID_HTTP_PORT` or `MANEBID_HTTPS_PORT` only if the default host ports are
  already occupied.
- For a public installation where Caddy is the internet-facing web server, set
  `MANEBID_SITE_ADDRESS` to the public DNS name without a URL scheme or path,
  for example `auction.example.org`. Keep `MANEBID_HTTP_PORT=80` and
  `MANEBID_HTTPS_PORT=443` so that Caddy can complete ACME validation.
- For a public installation behind a TLS-terminating reverse proxy, include the
  explicit HTTP scheme, for example:

  ```dotenv
  MANEBID_SITE_ADDRESS=http://auction.example.org
  MANEBID_HTTP_PORT=80
  MANEBID_HTTPS_PORT=8443
  ```

  The `http://` prefix is required in this topology. It tells Caddy to serve an
  unencrypted origin instead of enabling automatic HTTPS and redirecting the
  proxy back to the public HTTPS URL. Set `MANEBID_HTTP_PORT` to the private
  host port used as the proxy destination. The HTTPS mapping is unused; choose
  an otherwise unused host port for it.

For a direct public Caddy installation, confirm before starting that the DNS
name points to this host and that the firewall and any router port forwarding
allow inbound TCP 80 and 443. UDP 443 is optional and enables HTTP/3. Caddy
automatically requests and renews the public certificate.

For an upstream TLS proxy, configure one hostname-level rule that accepts
`HTTPS` for the public DNS name and forwards all paths to
`http://<docker-host>:<MANEBID_HTTP_PORT>`. The proxy must retain the original
`Host`, identify the original scheme as HTTPS, and manage the public
certificate and HTTP-to-HTTPS redirection. Do not expose the unencrypted origin
port to the internet; restrict it to the proxy's private address where the host
firewall permits.

In both topologies, do not publish backend port 3000 or add a route directly to
it; all browser and SumUp callback traffic must pass through the web service.

Build and start the deployment:

```bash
docker compose build
docker compose up -d
docker compose ps
```

Both services should report as healthy. Check their startup logs before signing
in:

```bash
docker compose logs backend
docker compose logs web
```

For a local installation, Caddy gives `localhost` a locally issued certificate.
Open `https://localhost/`; a new machine/browser may warn until Caddy's local
root certificate is trusted. For a command-line smoke test without installing
that local CA:

```bash
curl --insecure https://localhost/api/healthz
```

For a public installation, open the configured HTTPS hostname. With direct
Caddy TLS, check `docker compose logs web` if Caddy cannot obtain a
certificate. With upstream TLS termination, inspect the upstream proxy's
certificate assignment and destination rule instead; Caddy should not request
a certificate in this mode.

The health endpoint should return `{"status":"ok"}`. Obtain the one-time
initial root password from the first backend startup log, then sign in and
change it:

```bash
docker compose logs backend
```

For a local installation, if ports 80 or 443 are already in use, change
`MANEBID_HTTP_PORT` and `MANEBID_HTTPS_PORT` in `.env`. With a non-standard
HTTPS port, browse directly to it, for example `https://localhost:8443/`; the
HTTP-to-HTTPS redirect still uses the site's normal HTTPS port. Do not use
non-standard host ports for a direct public Caddy deployment unless an upstream
router or proxy maps public ports 80 and 443 to them.

## SumUp and secret handling

SumUp can be used safely with this deployment when the Docker host is trusted
and maintained. The API key, merchant code, affiliate key, and application ID
are loaded at runtime from the Compose secret
`/run/secrets/manebid_env`. They are not copied into either image, embedded in
the frontend, or placed in normal container environment variables.

Docker Compose secrets are protected runtime file mounts, not an encrypted
secret vault. Security still depends on the source `manebid.env` permissions,
Docker daemon access, host backups, and host security. For a larger orchestrated
deployment, the same application can point `MANEBID_ENV_FILE` at a secret
mounted by that platform.

For hosted SumUp payments, use:

```dotenv
SUMUP_WEB_ENABLED=true
SUMUP_API_KEY=...
SUMUP_MERCHANT_CODE=...
SUMUP_RETURN_URL=https://auction.example.org/payments/sumup/webhook
```

For card-present payments, also configure the affiliate key, app ID, and the
documented success/failure URLs. See [SumUp setup](sumup_setup.md) for the full
list and required SumUp permissions. The Caddy configuration deliberately
passes `/payments/sumup/*` to the backend without stripping that prefix, while
normal browser API calls use the stripped `/api/*` route.

After changing `manebid.env`, recreate the backend so it reads the updated
secret file:

```bash
docker compose up -d --force-recreate backend
```

Never put real credentials in `.env`, `compose.yaml`, `backend-config.json`, a
Dockerfile, build arguments, browser JavaScript, or an image registry.

## Non-secret configuration

The default container settings are in `backend-config.json`. They differ from
the standalone defaults in several important ways:

- the backend binds to the private container network (`HOST=0.0.0.0`), but no
  host port is published;
- exactly one proxy hop is trusted (`TRUSTED_PROXIES=1`), and Caddy replaces
  client-supplied forwarding headers;
- application storage is measured from `/app` rather than from the container
  filesystem root;
- every writable path is below `/var/lib/manebid` on the persistent volume;
- `RESTART_MODE=exit` asks the container supervisor to restart the process
  rather than invoking systemd or PM2.

To customise non-secret settings, copy the file, edit the copy, and set its
path in `.env`:

```bash
cp backend-config.json backend-config.local.json
```

```dotenv
MANEBID_CONFIG_SOURCE=./backend-config.local.json
```

Keep the four container-specific behaviours above. In particular, do not use
the standalone `backend/config.json` unchanged inside Docker.

## Day-to-day operation

Run these commands from `deploy/docker`:

```bash
docker compose ps
docker compose logs --follow backend
docker compose logs --follow web
docker compose restart
docker compose stop
docker compose start
docker compose down
```

`docker compose down` removes containers and the private network but preserves
the named volumes. `docker compose down --volumes` permanently removes the
database, uploads, resources, generated files, logs, and Caddy state; use it
only when intentionally deleting the installation.

The Maintenance UI's restart action is supported. The backend exits cleanly,
flushes operator messages, closes SQLite, and Compose's `unless-stopped` policy
starts a replacement process. An explicit `docker compose stop` remains
stopped, as expected.

For the server-management CLI, stop the normal backend first so that only one
process writes the SQLite database:

```bash
docker compose stop backend
docker compose run --rm backend node server-management.js
docker compose start backend
```

## Backups and migration

Use ManeBid's Maintenance UI to create and download managed backups. This is
the preferred backup format because it includes metadata and can include the
database, photos, and configuration resources consistently.

To move an existing standalone installation into Docker, create a managed
backup in the existing installation, start a fresh Docker deployment, and use
the Maintenance UI to inspect and restore that archive. The same method works
in reverse. Keep the old instance stopped once the new copy is in service so
that users cannot update two diverging databases.

The Docker volume is not a substitute for an off-host backup. If a raw volume
backup is required, stop the backend before copying the SQLite files and the
rest of `manebid_data`; never copy a live SQLite database without its WAL state.

## Upgrading

Create and download a managed backup first. Then update the checkout and
replace the application containers:

```bash
git pull --ff-only
cd deploy/docker
docker compose build --pull
docker compose up -d
docker compose ps
```

The named volumes remain attached. Check the backend log for schema migration
messages and confirm `/api/healthz` before resuming auction operations.

## Troubleshooting

- `address already in use`: change the host ports for local use, stop the
  conflicting service for direct Caddy TLS, or use a private HTTP origin port
  behind an upstream TLS-terminating proxy.
- backend is unhealthy: inspect `docker compose logs backend`; configuration,
  missing `SECRET_KEY`, invalid SumUp settings, and volume permissions are
  reported at startup.
- web is unhealthy or TLS is unavailable with direct Caddy TLS: inspect
  `docker compose logs web` and verify DNS, inbound 80/443, and outbound HTTPS.
- TLS fails behind an upstream reverse proxy: confirm that
  `MANEBID_SITE_ADDRESS` starts with `http://`, the proxy owns the public
  certificate, and its HTTPS rule forwards to the configured private HTTP
  origin port.
- browser loads the frontend but API calls fail: verify both containers are
  healthy and that `TRUSTED_PROXIES` remains `1` in the container config.
- local certificate warning: use `curl --insecure` only for local testing, or
  install Caddy's local root CA into the test machine's trust store. Never use
  an insecure TLS bypass for production SumUp traffic.

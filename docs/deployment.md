# Deployment

Run the backend on a Linux server with Docker. `deploy.sh` does the work, and rolls back if a new version does not come up healthy.

## Quick start

On a server with Docker and the compose plugin:

```bash
git clone https://github.com/voltkit-rtc/voltkit-rtc-backend-demo.git
cd voltkit-rtc-backend-demo
./deploy.sh init        # makes .env.production with a new JWT secret and database password
nano .env.production    # add VOLTKIT_RTC_SECRET, and DOMAIN for HTTPS
./deploy.sh             # builds, starts, waits until healthy
```

To update later:

```bash
git pull origin main
./deploy.sh
```

Or deploy from your own computer. This copies the folder, `.env.production` included, and runs it on the server:

```bash
./deploy.sh remote user@your-server
```

## Choose how it is reached

| Your setup | `.env.production` | What runs |
| --- | --- | --- |
| A domain, and nothing else on the server | `DOMAIN=api.example.com` | Caddy serves HTTPS on 443 with a free certificate |
| Your own nginx or load balancer | `DOMAIN=` and `TRUST_PROXY=1` | The API on port 5051, for your proxy to reach |
| Testing | `DOMAIN=` | The API in plain http on port 5051 |

For `DOMAIN`, point its DNS at the server first, and open ports 80 and 443.

**Why https matters:** session tokens and VoltKit tokens travel in these requests, and Android refuses plain http in release builds.

## Choose a database

| Your setup | `MONGODB_URI` |
| --- | --- |
| MongoDB in Docker beside the API | Leave what `init` wrote |
| MongoDB Atlas | `mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/voltkit_live?retryWrites=true&w=majority` |
| MongoDB on this same server | Use `host.docker.internal` as the host |

`deploy.sh` runs a MongoDB container only when `MONGODB_URI` points at the host `mongo`. Its data is kept in a named volume, so it survives redeploys.

**Atlas:** add your server's IP address under **Network Access**, or the connection is refused. Name the database in the string: without one, data goes into a database called `test`.

**Why not `localhost`:** inside a container that means the container itself. `deploy.sh` stops with an explanation if it sees one.

## Settings

| Setting | Required | What it does |
| --- | --- | --- |
| `VOLTKIT_RTC_URL`, `VOLTKIT_RTC_SECRET` | Yes | Your VoltKit project |
| `MONGODB_URI` | Yes | The database |
| `JWT_SECRET` | Yes | Signs guest sessions, at least 32 characters. Changing it signs everyone out |
| `DOMAIN` | No | Turns on HTTPS through Caddy |
| `API_PORT` | No | Published port when `DOMAIN` is empty. Default 5051 |
| `TRUST_PROXY` | Behind a proxy | How many proxies sit in front of the API |
| `MONGO_ROOT_USER`, `MONGO_ROOT_PASSWORD` | Docker MongoDB | Its login, which must match `MONGODB_URI` |
| `MAX_LIVE_ROOMS` | No | Rooms live at once. Default 50 |
| `STARTING_COINS`, `TOPUP_COINS` | No | Demo coins |

> [!IMPORTANT]
> `.env.production` holds your secrets. It is ignored by git and left out of the Docker image, and `init` makes it readable by you only. Never commit it.

## Behind your own proxy

Two things need to be right, or parts of the app will quietly misbehave.

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  server_name api.example.com;

  location / {
    proxy_pass http://127.0.0.1:5051;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
```

**Why the `Upgrade` lines:** the app uses a WebSocket for 1v1 matching and live room updates. Without them, 1v1 never connects. The `map` matters too: forcing `Connection: upgrade` on
every request breaks ordinary ones.

**Why `X-Forwarded-For` and `TRUST_PROXY=1`:** without them, every visitor looks like your proxy, so they all share one rate limit. After 20 sign-ups in an hour, nobody else could sign up.

Check it from outside:

```bash
curl https://api.example.com/health
```

## Commands

| Command | What it does |
| --- | --- |
| `./deploy.sh init` | Creates `.env.production` |
| `./deploy.sh` | Builds and starts, and rolls back on failure |
| `./deploy.sh status` | Shows containers and health |
| `./deploy.sh logs [api\|mongo\|caddy]` | Follows the logs |
| `./deploy.sh backup` | Dumps the Docker MongoDB into `./backups`, and prints the restore command |
| `./deploy.sh down` | Stops everything. Data and certificates are kept |
| `./deploy.sh remote user@host [dir]` | Copies the folder to a server and deploys there |

## What `deploy.sh` checks

Before building, it stops with a clear message if a required setting is empty, a `CHANGE_ME` is left in the file, `JWT_SECRET` is too short, the database address is `localhost`, or the
MongoDB password does not match `MONGODB_URI`.

Then it tags the running image as `previous`, builds, starts, and waits for `/health`. If the new version is not healthy, it prints the logs and goes back to `previous`.

**Why `/health` checks the database:** a server that cannot reach MongoDB is not ready for traffic, so it answers 503 and the deploy fails instead of going live broken. The server also exits if
your VoltKit secret is wrong, which counts as a failed deploy.

## Limits of this setup

- **One instance.** The 1v1 waiting line is held in memory, and Socket.IO is not set up across servers. For several instances, move both to Redis.
- **Reports are only stored.** Nothing here reviews them. A real product needs someone who does.
- **Data retention.** Ended rooms are removed after seven days. Guests stay until they delete themselves.

## After deploying

The app has the backend's address built in. Set `EXPO_PUBLIC_API_URL` to your address and build again: see
[Going to production](https://github.com/voltkit-rtc/react-native-example-audio-video/blob/main/docs/going-to-production.md).

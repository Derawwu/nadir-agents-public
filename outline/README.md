# Outline Wiki

Self-hosted knowledge base running alongside Plane on the nadir-agents stack.

**URL:** http://localhost:3002

## Start

```powershell
cd D:\nadir-agents\outline
docker-compose up -d
```

## Stop

```powershell
cd D:\nadir-agents\outline
docker-compose down
```

## Status

```powershell
cd D:\nadir-agents\outline
docker-compose ps
```

## Backup

The database lives in the Docker volume `outline_outline-pgdata`. To back it up:

```powershell
# Dump the database to a file
docker exec outline-outline-postgres-1 pg_dump -U outline outline > outline-backup.sql
```

To restore:

```powershell
docker exec -i outline-outline-postgres-1 psql -U outline outline < outline-backup.sql
```

Uploaded files are stored inside the `outline-outline-1` container at `/var/lib/outline/data`.
To back those up, copy the files out while the container is running:

```powershell
docker cp outline-outline-1:/var/lib/outline/data ./outline-files-backup
```

## First-time admin setup

1. Open http://localhost:3002
2. Click **Create account** and enter your email address.
3. Because SMTP is disabled, the magic-link email won't arrive. Instead, check the
   container logs for the sign-in URL:

   ```powershell
   docker logs outline-outline-1 2>&1 | Select-String "magic"
   ```

   Copy the URL from the log and open it in the browser.
4. You are now signed in as the first user, who is automatically an admin.
5. From **Settings → Members** you can invite additional users the same way.

## Network isolation

Outline uses the `outline-network` bridge network. It has no connection to Plane's
network — the two stacks are fully isolated.

## Secrets

Start from `.env.example` (`cp .env.example .env`). Generate `SECRET_KEY` and
`UTILS_SECRET` with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
`OUTLINE_PG_PASSWORD` must match the password inside `DATABASE_URL`; Postgres
only reads it when the database volume is first created.
Do not share `.env` publicly.

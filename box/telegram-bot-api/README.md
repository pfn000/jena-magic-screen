# Optional Telegram Bot API sidecar for Jena's box

This builds **Telegram's official Bot API server** from upstream source: https://github.com/tdlib/telegram-bot-api

It is not another bot and does not replace your existing bot's handlers, commands, or token. It supplies a local HTTP implementation of Telegram's Bot API for a bot process that is configured to use it.

## When it is useful

The hosted Bot API at https://api.telegram.org is enough for most bots. The self-hosted server's special --local mode enables capabilities including uploads up to 2,000 MB, downloading files without the normal size limit, local-path file uploads, and local HTTP webhooks. It needs Telegram application credentials (api_id and api_hash) from https://my.telegram.org. These are **not** the bot token.

Don't migrate an already-working bot just for speed. The local server adds build time, persistent storage and another service to monitor.

## Safe deployment beside Jena

This service is opt-in and **does not publish port 8081 to the host or Internet**. It listens on the private Docker network only. It needs its own writable persistent /data volume.

1. Create a private Docker network (once):

       docker network create jena-private

2. Attach the existing Jena box container to it. Replace the container name with the actual running name:

       docker network connect jena-private JENA_BOX_CONTAINER_NAME

3. Copy .env.example to .env in this directory and set TELEGRAM_API_ID and TELEGRAM_API_HASH. Keep .env out of Git. Do not send credentials in chat, logs or screenshots.

4. Start the Bot API sidecar from the repository root:

       docker compose --env-file box/telegram-bot-api/.env -f box/telegram-bot-api/docker-compose.yml up -d --build

5. After that, the bot container can reach the local API at http://telegram-bot-api:8081. Configure the **existing bot framework** to use this URL as its Bot API base URL; SDKs differ on whether the base should end in /bot. The public repository currently contains no Telegram bot implementation, so this integration must be wired to the existing bot's own configuration once its framework is identified.

6. First verify ordinary bot actions on a test bot or during a planned maintenance window. Keep the current https://api.telegram.org endpoint until you deliberately migrate.

## Important migration warning

Telegram documents that a bot moving from the hosted Bot API to a local Bot API server must call logOut on https://api.telegram.org before switching endpoints to ensure updates aren't delivered on competing servers. **Do not call logOut automatically as part of deployment.** It affects delivery, and should happen only when you intentionally migrate the bot and are ready to point it at the local API.

Official upstream migration notes: https://github.com/tdlib/telegram-bot-api#moving-a-bot-to-a-local-server

## Security

- Never publish port 8081 to the Internet. It is plain HTTP; upstream recommends a TLS termination proxy if remote HTTPS access is required. The Docker configuration intentionally exposes no host port.
- Store TELEGRAM_API_ID and TELEGRAM_API_HASH in a private env file or secret manager. Do not commit .env.
- The Bot API server doesn't need your bot token just to run; that token stays with the actual bot process.
- Back up the persistent jena-telegram-bot-api-data volume. This server's local files may include user-uploaded media.
- If the existing bot doesn't need local-mode file limits, leave it on Telegram's hosted API.

## Troubleshooting

    docker compose --env-file box/telegram-bot-api/.env -f box/telegram-bot-api/docker-compose.yml logs --tail=100 telegram-bot-api
    docker network inspect jena-private

Build uses the official tdlib/telegram-bot-api source and may take a while. Confirm it compiles and starts on the intended host before changing the live bot's endpoint.

# Official Telegram Bot API server, built from upstream source.
FROM debian:bookworm-slim AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git gperf ca-certificates libssl-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --recursive https://github.com/tdlib/telegram-bot-api.git /src/telegram-bot-api \
 && cmake -S /src/telegram-bot-api -B /src/telegram-bot-api/build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
 && cmake --build /src/telegram-bot-api/build --target install -j2

FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 zlib1g libstdc++6 libgcc-s1 bash \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --create-home --shell /usr/sbin/nologin botapi \
 && mkdir -p /data/files /tmp/telegram-bot-api \
 && chown -R botapi:botapi /data /tmp/telegram-bot-api
COPY --from=build /usr/local/ /usr/local/
USER 10001:10001
WORKDIR /data
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/telegram-bot-api", "--local", "--http-port=8081", "--http-ip-address=0.0.0.0", "--dir=/data", "--files-dir=/data/files", "--temp-dir=/tmp/telegram-bot-api"]
